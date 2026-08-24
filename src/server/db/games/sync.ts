/**
 * Owner-scoped data access for `game_sync_runs` and `game_sync_changes`.
 *
 * Same discipline as `src/server/db/games/play-years.ts`: `ownerId` is the
 * first parameter of every function and goes into every WHERE. Nothing in
 * this module ever writes to `games` — a run only stages `PlannedChange`s
 * (`src/server/games/sync-plan.ts`, pure) for the owner to review. Applying
 * the selected ones is a later task's job.
 */

import { and, asc, eq } from 'drizzle-orm';

import { getDb } from '@/server/db';
import { gameSyncChanges, gameSyncRuns } from '@/server/db/schema';
import type { PlannedChange, SyncChangeKind } from '@/server/games/sync-plan';

export type SyncRunStatus = 'running' | 'ready' | 'committed' | 'failed' | 'cancelled';

export interface SyncRun {
  readonly id: string;
  readonly source: 'steam' | 'psn';
  readonly status: SyncRunStatus;
  /** Progress display only — see the column's own doc comment in `schema.ts`. Not what drives chunking. */
  readonly cursor: number;
  readonly total: number;
  /** Keyset pagination bookmark: the `id` of the last processed game, or `null` before any chunk has run. */
  readonly lastGameId: string | null;
  readonly errorMessage: string | null;
}

export interface SyncChange extends PlannedChange {
  readonly id: string;
  readonly selected: boolean;
}

function rowToSyncRun(row: typeof gameSyncRuns.$inferSelect): SyncRun {
  return {
    id: row.id,
    source: row.source,
    status: row.status,
    cursor: row.cursor,
    total: row.total,
    lastGameId: row.lastGameId,
    errorMessage: row.errorMessage,
  };
}

function rowToSyncChange(row: typeof gameSyncChanges.$inferSelect): SyncChange {
  return {
    id: row.id,
    kind: row.kind as SyncChangeKind,
    gameId: row.gameId,
    title: row.title,
    payload: row.payload as Record<string, unknown>,
    selected: row.selected,
  };
}

/** Starts a run at cursor 0, holding the library snapshot it will be matched against. */
export async function createSyncRun(
  ownerId: string,
  source: 'steam',
  total: number,
  steamLibrary: unknown,
): Promise<SyncRun> {
  const db = getDb();
  const rows = await db.insert(gameSyncRuns).values({ ownerId, source, total, steamLibrary }).returning();

  const row = rows[0];
  if (!row) throw new Error('Sync run insert returned no row');
  return rowToSyncRun(row);
}

export async function getSyncRun(ownerId: string, runId: string): Promise<SyncRun | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(gameSyncRuns)
    .where(and(eq(gameSyncRuns.id, runId), eq(gameSyncRuns.ownerId, ownerId)))
    .limit(1);

  const row = rows[0];
  return row ? rowToSyncRun(row) : null;
}

/** The library snapshot the run started with, or `null` if the run does not exist or belongs to someone else. */
export async function getSyncRunLibrary(ownerId: string, runId: string): Promise<unknown> {
  const db = getDb();
  const rows = await db
    .select({ steamLibrary: gameSyncRuns.steamLibrary })
    .from(gameSyncRuns)
    .where(and(eq(gameSyncRuns.id, runId), eq(gameSyncRuns.ownerId, ownerId)))
    .limit(1);

  const row = rows[0];
  return row ? row.steamLibrary : null;
}

/**
 * Insert changes and advance the run's cursor in ONE transaction, with TWO
 * independent layers of owner enforcement rather than one:
 *
 * 1. A pre-check on the run, which guards the INSERT — an `INSERT VALUES`
 *    has no WHERE clause of its own to scope by ownership, so ownership has
 *    to be verified before it runs, not during it. Mirrors the pre-check
 *    pattern in `replacePlayYears` (`src/server/db/games/play-years.ts`).
 * 2. An `ownerId` predicate directly on the cursor UPDATE's WHERE, exactly
 *    like `replacePlayYears`' DELETE keeps its own filter even though it
 *    already has the same pre-check above it. The UPDATE is NOT gated by an
 *    early return on the pre-check result — it runs unconditionally and
 *    relies on its own filter, so a run belonging to someone else matches
 *    zero rows here and this is a silent no-op regardless of what the
 *    pre-check found. Two independent layers, not one guarding both writes.
 *
 * `selected` defaults to `true` at the column level, which is correct for
 * `link`, `field_update` and `new_game` — but WRONG for `reconcile`: a
 * reconciliation item is an advisory "your year-by-year split no longer adds
 * up" note that applies nothing at commit, and the review screen requires
 * needs-attention items never be pre-selected. So it is computed per change
 * here rather than left to the column default.
 *
 * `nextLastGameId` is the keyset pagination bookmark (see `schema.ts`'s doc
 * comment on the column) — deliberately OPTIONAL, and left untouched in the
 * database when omitted, rather than defaulting to `null`. `null` is a
 * meaningful value here (it is the run's genuine starting state), so
 * "the caller didn't pass one" has to be distinguishable from "the caller
 * explicitly wants it cleared" — the existing `errorMessage` param just
 * below uses the same `!== undefined` convention for the same reason. This
 * also keeps every pre-existing call site (this module's own integration
 * tests included) working unchanged: only the sync engine passes it.
 */
export async function appendSyncChanges(
  ownerId: string,
  runId: string,
  changes: readonly PlannedChange[],
  nextCursor: number,
  nextLastGameId?: string | null,
): Promise<void> {
  const db = getDb();

  await db.transaction(async (tx) => {
    const owned = await tx
      .select({ id: gameSyncRuns.id })
      .from(gameSyncRuns)
      .where(and(eq(gameSyncRuns.id, runId), eq(gameSyncRuns.ownerId, ownerId)))
      .limit(1);

    if (owned.length > 0 && changes.length > 0) {
      await tx.insert(gameSyncChanges).values(
        changes.map((change) => ({
          ownerId,
          runId,
          gameId: change.gameId,
          kind: change.kind,
          title: change.title,
          selected: change.kind !== 'reconcile',
          payload: change.payload,
        })),
      );
    }

    await tx
      .update(gameSyncRuns)
      .set({
        cursor: nextCursor,
        updatedAt: new Date(),
        ...(nextLastGameId !== undefined ? { lastGameId: nextLastGameId } : {}),
      })
      .where(and(eq(gameSyncRuns.id, runId), eq(gameSyncRuns.ownerId, ownerId)));
  });
}

/** Marks a run done. `errorMessage` is meaningful only for `'failed'`; omit it for every other status. */
export async function finishSyncRun(
  ownerId: string,
  runId: string,
  status: SyncRunStatus,
  errorMessage?: string,
): Promise<void> {
  const db = getDb();
  await db
    .update(gameSyncRuns)
    .set({
      status,
      updatedAt: new Date(),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    })
    .where(and(eq(gameSyncRuns.id, runId), eq(gameSyncRuns.ownerId, ownerId)));
}

export async function listSyncChanges(ownerId: string, runId: string): Promise<SyncChange[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(gameSyncChanges)
    .where(and(eq(gameSyncChanges.runId, runId), eq(gameSyncChanges.ownerId, ownerId)))
    .orderBy(asc(gameSyncChanges.createdAt));

  return rows.map(rowToSyncChange);
}

/** Toggles the owner's own review selection. Filters on `ownerId` in its WHERE — never another owner's change. */
export async function setSyncChangeSelected(ownerId: string, changeId: string, selected: boolean): Promise<void> {
  const db = getDb();
  await db
    .update(gameSyncChanges)
    .set({ selected })
    .where(and(eq(gameSyncChanges.id, changeId), eq(gameSyncChanges.ownerId, ownerId)));
}
