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
import { games as gamesTable, gameSyncChanges, gameSyncRuns } from '@/server/db/schema';
import type { PlannedChange, SyncChangeKind } from '@/server/games/sync-plan';
import { SyncRunAlreadyCommittedError, SyncRunNotFoundError } from './errors';

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

/**
 * The four `games` columns a `field_update` change is allowed to touch.
 * Whitelisted BY NAME rather than trusted from the payload — `payload.field`
 * is JSONB staged by a sync run, not a compile-time-checked value — so a
 * field name outside this set is a bug in the staging code, and
 * `assertSyncableField` throws rather than let it anywhere near a dynamic
 * `.set()` key.
 */
const SYNCABLE_FIELDS = ['hoursTenths', 'achievementsUnlocked', 'achievementsTotal', 'steamAppid'] as const;
type SyncableField = (typeof SYNCABLE_FIELDS)[number];

function assertSyncableField(field: unknown): SyncableField {
  if (typeof field === 'string' && (SYNCABLE_FIELDS as readonly string[]).includes(field)) {
    return field as SyncableField;
  }
  throw new Error(`field_update named a non-syncable column: ${JSON.stringify(field)}`);
}

/**
 * The `.set()` patch for one `field_update`, built with an explicit switch —
 * never `{ [field]: to }`. A computed key would still typecheck today, which
 * is exactly why it is not used: the switch, not the whitelist check alone,
 * is what makes "interpolate an arbitrary column name" structurally
 * impossible to reintroduce later.
 */
function fieldUpdatePatch(field: SyncableField, to: number): Partial<typeof gamesTable.$inferInsert> {
  switch (field) {
    case 'hoursTenths':
      return { hoursTenths: to };
    case 'achievementsUnlocked':
      return { achievementsUnlocked: to };
    case 'achievementsTotal':
      return { achievementsTotal: to };
    case 'steamAppid':
      return { steamAppid: to };
  }
}

/** `link` must land before a `field_update` that might assume it; `new_game` last; `reconcile` never applies (see `commitSyncRun`). */
const COMMIT_ORDER: Record<SyncChangeKind, number> = { link: 0, field_update: 1, new_game: 2, reconcile: 3 };

/**
 * Applies every SELECTED change in a run to `games`, in one transaction, then
 * marks the run `committed`. Never writes to a game not named by a selected
 * change, and never deletes or hides a `games` row — this is the one place
 * in the whole sync feature that is allowed to touch `games` at all (every
 * earlier module only stages `game_sync_changes` rows; see
 * `src/features/games/sync/sync-actions.ts`'s own "no-delete invariant"
 * doc comment for the sibling guarantee on the staging side).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `reconcile` IS SKIPPED, ALWAYS — NOT BECAUSE IT IS UNSELECTED
 *
 * A reconciliation item is advisory only ("your year-by-year split no longer
 * adds up to the new total") and is skipped here unconditionally, even if it
 * somehow carries `selected: true` — `appendSyncChanges` stages it `false` by
 * default, but this function does not lean on that; it is an independent
 * guard, not a re-derivation of the staging default. There is nothing a
 * `reconcile` change could apply anyway: it names no `games` column.
 *
 * WHY ONE TRANSACTION
 *
 * The owner reviews and approves a SET of changes together. Applying half of
 * them and then failing on the other half would leave `games` in a state
 * never actually approved. `db.transaction()` rolls back everything the
 * moment anything inside throws — including `assertSyncableField` rejecting
 * a bad field name — so a single bad change aborts the WHOLE commit, not
 * just its own row.
 *
 * `link`/`field_update` writes stay scoped to `ownerId` in their own WHERE,
 * exactly like every other write in this module, even though the run-level
 * pre-check above already confirmed ownership of the RUN — a change's
 * `gameId` is trusted data staged by this owner's own run, but the filter
 * costs nothing and this module never assumes a foreign key alone is
 * sufficient scoping.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export async function commitSyncRun(
  ownerId: string,
  runId: string,
): Promise<{ readonly applied: number; readonly created: number }> {
  const db = getDb();

  return db.transaction(async (tx) => {
    const runs = await tx
      .select()
      .from(gameSyncRuns)
      .where(and(eq(gameSyncRuns.id, runId), eq(gameSyncRuns.ownerId, ownerId)))
      .limit(1);

    const run = runs[0];
    if (!run) throw new SyncRunNotFoundError();
    if (run.status === 'committed') throw new SyncRunAlreadyCommittedError();

    const selectedChanges = await tx
      .select()
      .from(gameSyncChanges)
      .where(
        and(
          eq(gameSyncChanges.runId, runId),
          eq(gameSyncChanges.ownerId, ownerId),
          eq(gameSyncChanges.selected, true),
        ),
      )
      .orderBy(asc(gameSyncChanges.createdAt));

    // `Array.prototype.sort` is stable (guaranteed since ES2019): changes of
    // the SAME kind keep the staging order the query's own `orderBy` above
    // already gave them. Only the kind buckets themselves get reordered.
    const ordered = [...selectedChanges].sort(
      (a, b) => COMMIT_ORDER[a.kind as SyncChangeKind] - COMMIT_ORDER[b.kind as SyncChangeKind],
    );

    let applied = 0;
    let created = 0;

    for (const change of ordered) {
      const kind = change.kind as SyncChangeKind;
      const payload = change.payload as Record<string, unknown>;

      if (kind === 'reconcile') continue; // Advisory only — see doc comment above.

      if (kind === 'link') {
        if (change.gameId === null) throw new Error('link change is missing a gameId');
        const steamAppid = payload.steamAppid;
        if (typeof steamAppid !== 'number') {
          throw new Error('link change payload is missing a numeric steamAppid');
        }
        await tx
          .update(gamesTable)
          .set({ steamAppid, updatedAt: new Date() })
          .where(and(eq(gamesTable.id, change.gameId), eq(gamesTable.ownerId, ownerId)));
        applied += 1;
        continue;
      }

      if (kind === 'field_update') {
        if (change.gameId === null) throw new Error('field_update change is missing a gameId');
        const field = assertSyncableField(payload.field);
        const to = payload.to;
        if (typeof to !== 'number') throw new Error('field_update change payload is missing a numeric "to"');
        await tx
          .update(gamesTable)
          .set({ ...fieldUpdatePatch(field, to), updatedAt: new Date() })
          .where(and(eq(gamesTable.id, change.gameId), eq(gamesTable.ownerId, ownerId)));
        applied += 1;
        continue;
      }

      if (kind === 'new_game') {
        const steamAppid = payload.steamAppid;
        const hoursTenths = payload.hoursTenths;
        if (typeof steamAppid !== 'number' || typeof hoursTenths !== 'number') {
          throw new Error('new_game change payload is missing a numeric steamAppid or hoursTenths');
        }
        await tx.insert(gamesTable).values({
          ownerId,
          title: change.title,
          platform: 'steam',
          steamAppid,
          hoursTenths,
          // A game arriving with recorded hours is already underway or done;
          // one at zero was just discovered on Steam and has not been played
          // yet. New rows never land in 'playing' — sync cannot know that.
          status: hoursTenths > 0 ? 'completed' : 'backlog',
        });
        created += 1;
        continue;
      }
    }

    await tx
      .update(gameSyncRuns)
      .set({ status: 'committed', updatedAt: new Date() })
      .where(and(eq(gameSyncRuns.id, runId), eq(gameSyncRuns.ownerId, ownerId)));

    return { applied, created };
  });
}
