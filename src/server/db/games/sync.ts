/**
 * Owner-scoped data access for `game_sync_runs` and `game_sync_changes`.
 *
 * Same discipline as `src/server/db/games/play-years.ts`: `ownerId` is the
 * first parameter of every function and goes into every WHERE. Nothing in
 * this module ever writes to `games` — a run only stages `PlannedChange`s
 * (`src/server/games/sync-plan.ts`, pure) for the owner to review. Applying
 * the selected ones is a later task's job.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { getDb } from '@/server/db';
import { games as gamesTable, gameSyncChanges, gameSyncRuns } from '@/server/db/schema';
import type { PlannedChange, SyncChangeKind } from '@/server/games/sync-plan';
import { GAME_PLATFORMS, type GamePlatform } from '@/server/games/taxonomy';
import { SyncRunAlreadyCommittedError, SyncRunNotFoundError, SyncRunNotReadyError } from './errors';

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

/**
 * Starts a run at cursor 0, holding the library snapshot it will be matched
 * against. `librarySnapshot` is stored in the `steamLibrary` jsonb column
 * regardless of `source` — that column is a transient, run-scoped blob (see
 * its own doc comment in `schema.ts`), not a Steam-specific contract, and
 * reusing it for PSN's `{ playedTitles, trophyTitles }` snapshot avoids a
 * migration for what is genuinely the same "one third-party fetch per run,
 * held for every chunk to match against" role Steam already gave it.
 */
/**
 * `psnTokenFingerprint` is meaningful only for `source: 'psn'` — see the
 * column's own doc comment in `schema.ts`. Deliberately OPTIONAL and left
 * out of the insert entirely when omitted (rather than defaulting to
 * `undefined`/`null` explicitly), matching the `exactOptionalPropertyTypes`
 * convention `appendSyncChanges`' own `nextLastGameId` param already uses
 * in this file. Every Steam call site simply never passes it.
 */
export async function createSyncRun(
  ownerId: string,
  source: 'steam' | 'psn',
  total: number,
  librarySnapshot: unknown,
  psnTokenFingerprint?: string,
): Promise<SyncRun> {
  const db = getDb();
  const rows = await db
    .insert(gameSyncRuns)
    .values({
      ownerId,
      source,
      total,
      steamLibrary: librarySnapshot,
      ...(psnTokenFingerprint !== undefined ? { psnTokenFingerprint } : {}),
    })
    .returning();

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

/**
 * The library snapshot the run started with — a Steam `OwnedSteamGame[]` for
 * a `source: 'steam'` run, or a `{ playedTitles, trophyTitles }` object for
 * `source: 'psn'` (see `createSyncRun`'s doc comment) — or `null` if the run
 * does not exist or belongs to someone else. Returned as `unknown` on
 * purpose: this is a stored third-party snapshot, not a typed contract, so
 * each engine parses it defensively (`parseSteamLibrary` /
 * `parsePsnSnapshot`) rather than trusting its shape.
 */
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

/** The two run statuses that mean "this run actually reached the API and finished successfully." */
const SUCCESSFUL_SYNC_STATUSES = ['ready', 'committed'] as const;

/**
 * The most recent time each source successfully finished syncing for this
 * owner — `'ready'` or `'committed'` runs only. `'running'`, `'failed'` and
 * `'cancelled'` runs never reached the API successfully and are excluded, so
 * a sync that is mid-flight or that just failed can never make a stale
 * success look more recent than it was.
 *
 * A source with no successful run at all is simply ABSENT from the returned
 * map — never present with a `null` or placeholder value — so the UI can
 * render nothing for it rather than a permanent "never synced" line (see
 * `getLastSyncedTimesAction` in `src/features/games/sync/sync-actions.ts`).
 */
export async function getLastSuccessfulSyncTimes(ownerId: string): Promise<ReadonlyMap<'steam' | 'psn', Date>> {
  const db = getDb();
  const rows = await db
    .select({ source: gameSyncRuns.source, lastAt: sql<string>`max(${gameSyncRuns.updatedAt})` })
    .from(gameSyncRuns)
    .where(and(eq(gameSyncRuns.ownerId, ownerId), inArray(gameSyncRuns.status, SUCCESSFUL_SYNC_STATUSES)))
    .groupBy(gameSyncRuns.source);

  const result = new Map<'steam' | 'psn', Date>();
  for (const row of rows) {
    if (row.lastAt !== null) result.set(row.source, new Date(row.lastAt));
  }
  return result;
}

/**
 * The earliest successful (`'ready'` or `'committed'`) PSN run whose stored
 * `psnTokenFingerprint` matches `fingerprint` — i.e. how long the token
 * that produced `fingerprint` has actually been working, for this owner.
 *
 * Pasting a fresh `PSN_NPSSO` changes its fingerprint, so calling this with
 * the NEW fingerprint naturally "restarts the clock": no run staged under
 * the previous token can ever match the new fingerprint string, by
 * construction. A `null` stored `psnTokenFingerprint` — every run that
 * predates the column, and every Steam run — can likewise never equal a
 * real fingerprint under SQL equality (`NULL = 'x'` is never true), so
 * those rows are silently excluded rather than miscounted as evidence for
 * the current token. Returns `null` when the token behind `fingerprint` has
 * never completed a successful sync yet — genuinely unknown, not "just
 * issued."
 */
export async function getPsnTokenInUseSince(ownerId: string, fingerprint: string): Promise<Date | null> {
  const db = getDb();
  const rows = await db
    .select({ earliest: sql<string>`min(${gameSyncRuns.createdAt})` })
    .from(gameSyncRuns)
    .where(
      and(
        eq(gameSyncRuns.ownerId, ownerId),
        eq(gameSyncRuns.source, 'psn'),
        inArray(gameSyncRuns.status, SUCCESSFUL_SYNC_STATUSES),
        eq(gameSyncRuns.psnTokenFingerprint, fingerprint),
      ),
    );

  const value = rows[0]?.earliest;
  return value ? new Date(value) : null;
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
 * The `games` columns a `field_update` change is allowed to touch.
 * Whitelisted BY NAME rather than trusted from the payload — `payload.field`
 * is JSONB staged by a sync run, not a compile-time-checked value — so a
 * field name outside this set is a bug in the staging code, and
 * `assertSyncableField` throws rather than let it anywhere near a dynamic
 * `.set()` key. Extended for the PSN sync (Part 3): `firstPlayedYear`,
 * `platform`, `lastPlayedAt` and `platinum` join the original four —
 * `platinum` deliberately, since PSN is the one caller allowed to write it
 * (see `psn-plan.ts`'s module header).
 */
const SYNCABLE_FIELDS = [
  'hoursTenths',
  'achievementsUnlocked',
  'achievementsTotal',
  'steamAppid',
  'firstPlayedYear',
  'platform',
  'lastPlayedAt',
  'platinum',
] as const;
type SyncableField = (typeof SYNCABLE_FIELDS)[number];

function assertSyncableField(field: unknown): SyncableField {
  if (typeof field === 'string' && (SYNCABLE_FIELDS as readonly string[]).includes(field)) {
    return field as SyncableField;
  }
  throw new Error(`field_update named a non-syncable column: ${JSON.stringify(field)}`);
}

function isGamePlatform(value: unknown): value is GamePlatform {
  return typeof value === 'string' && (GAME_PLATFORMS as readonly string[]).includes(value);
}

/**
 * The `.set()` patch for one `field_update`, built with an explicit switch —
 * never `{ [field]: to }`. A computed key would still typecheck today, which
 * is exactly why it is not used: the switch, not the whitelist check alone,
 * is what makes "interpolate an arbitrary column name" structurally
 * impossible to reintroduce later. `to` is `unknown`, not `number`, because
 * the PSN fields added in Part 3 are not all numeric (`platform` is an enum
 * string, `lastPlayedAt` an ISO date string, `platinum` a boolean) — each
 * case validates its OWN expected shape rather than relying on one shared
 * pre-check the way the Steam-only version of this function used to.
 */
function fieldUpdatePatch(field: SyncableField, to: unknown): Partial<typeof gamesTable.$inferInsert> {
  switch (field) {
    case 'hoursTenths':
      if (typeof to !== 'number') throw new Error('field_update "hoursTenths" payload is missing a numeric "to"');
      return { hoursTenths: to };
    case 'achievementsUnlocked':
      if (typeof to !== 'number') throw new Error('field_update "achievementsUnlocked" payload is missing a numeric "to"');
      return { achievementsUnlocked: to };
    case 'achievementsTotal':
      if (typeof to !== 'number') throw new Error('field_update "achievementsTotal" payload is missing a numeric "to"');
      return { achievementsTotal: to };
    case 'steamAppid':
      if (typeof to !== 'number') throw new Error('field_update "steamAppid" payload is missing a numeric "to"');
      return { steamAppid: to };
    case 'firstPlayedYear':
      if (typeof to !== 'number') throw new Error('field_update "firstPlayedYear" payload is missing a numeric "to"');
      return { firstPlayedYear: to };
    case 'platform':
      if (!isGamePlatform(to)) throw new Error('field_update "platform" payload is missing a valid platform "to"');
      return { platform: to };
    case 'lastPlayedAt': {
      if (typeof to !== 'string') throw new Error('field_update "lastPlayedAt" payload is missing a string "to"');
      const parsed = new Date(to);
      if (Number.isNaN(parsed.getTime())) throw new Error('field_update "lastPlayedAt" payload has an unparseable date "to"');
      return { lastPlayedAt: parsed };
    }
    case 'platinum':
      if (typeof to !== 'boolean') throw new Error('field_update "platinum" payload is missing a boolean "to"');
      return { platinum: to };
  }
}

/**
 * The `games` columns a `link` change is allowed to set — Steam's single
 * `steamAppid` plus PSN's two separate identifier spaces (`psnTitleId` for
 * played-game data, `psnNpCommunicationId` for trophy data; see
 * `schema.ts`'s doc comment on why both exist). A PSN `link` payload may
 * carry ONE of these or BOTH at once (first-time link with a confident
 * trophy match already found) — see `planLinkedPsnGameChanges`.
 */
const LINK_FIELDS = ['steamAppid', 'psnTitleId', 'psnNpCommunicationId'] as const;
type LinkField = (typeof LINK_FIELDS)[number];

/**
 * The `.set()` patch for ONE identity field named in a `link` payload — same
 * switch-not-computed-key discipline as `fieldUpdatePatch` above, for the
 * same reason: a field name reaching this function has already been checked
 * against `LINK_FIELDS`, but the switch is what makes an arbitrary column
 * name structurally impossible to write, not just checked-against-a-list.
 */
function linkFieldPatch(field: LinkField, value: unknown): Partial<typeof gamesTable.$inferInsert> {
  switch (field) {
    case 'steamAppid':
      if (typeof value !== 'number') throw new Error('link payload has a non-numeric steamAppid');
      return { steamAppid: value };
    case 'psnTitleId':
      if (typeof value !== 'string' || value === '') throw new Error('link payload has an invalid psnTitleId');
      return { psnTitleId: value };
    case 'psnNpCommunicationId':
      if (typeof value !== 'string' || value === '') throw new Error('link payload has an invalid psnNpCommunicationId');
      return { psnNpCommunicationId: value };
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
 * ONLY A `ready` RUN MAY BE COMMITTED
 *
 * `running` has chunks still in flight — committing it approves a
 * half-populated set, and the engine would go on appending changes to a run
 * that is now `committed`, which is incoherent. `failed`/`cancelled` have
 * nothing valid to apply either. `committed` gets its own dedicated
 * `SyncRunAlreadyCommittedError` (checked first, below) so a double-commit's
 * message stays exactly "already committed"; every OTHER non-`ready` status
 * throws the less specific `SyncRunNotReadyError`.
 *
 * WHY THE ADVISORY LOCK
 *
 * Same defect `commitImport` (`src/server/db/finance/imports.ts`) already
 * documents and fixes: under READ COMMITTED, a plain `SELECT` does not
 * serialize against another transaction's `SELECT`. Two near-simultaneous
 * commits of the SAME run — a double-click before the button re-renders, two
 * tabs open on one run — can each read `status = 'ready'` before either has
 * written `'committed'`, and both then proceed to apply every selected
 * change. For `link`/`field_update` alone the writes happen to be
 * idempotent, so the immutability invariant breaks silently with no error;
 * for a `new_game`, the partial unique index on `(owner_id, steam_appid)`
 * makes the SECOND transaction's insert throw a raw, unwrapped Postgres
 * unique-violation instead of a clean refusal. `pg_advisory_xact_lock`,
 * taken as the very first statement — before the status read — makes the
 * second transaction BLOCK until the first's commit (or rollback) is
 * visible, so its own status read genuinely sees the first one's result and
 * takes the typed `SyncRunAlreadyCommittedError` path instead. Keyed to the
 * RUN (not the owner, unlike `commitImport`'s owner-wide lock): the
 * contested resource here is one run's status transition, not a
 * cross-record dedupe check shared by every import for an owner, so scoping
 * the lock to the run alone still fixes the actual race while letting two
 * DIFFERENT runs commit concurrently.
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
    // FIRST statement in the transaction, before the status read — see
    // "WHY THE ADVISORY LOCK" above. Keyed to the run, not the owner.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('burmy_sync_commit'), hashtext(${runId}))`);

    const runs = await tx
      .select()
      .from(gameSyncRuns)
      .where(and(eq(gameSyncRuns.id, runId), eq(gameSyncRuns.ownerId, ownerId)))
      .limit(1);

    const run = runs[0];
    if (!run) throw new SyncRunNotFoundError();
    if (run.status === 'committed') throw new SyncRunAlreadyCommittedError();
    if (run.status !== 'ready') throw new SyncRunNotReadyError(run.status);

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
        // A link payload names one or more identity fields BY KEY PRESENCE,
        // not by trusting an arbitrary key — only keys in the fixed
        // `LINK_FIELDS` tuple are ever read off `payload`, and each one is
        // routed through `linkFieldPatch`'s switch. See that function's doc
        // comment for why this is safe even though it is now data-driven.
        const presentFields = LINK_FIELDS.filter((field) => Object.hasOwn(payload, field));
        if (presentFields.length === 0) throw new Error('link change payload named no linkable identity field');

        let patch: Partial<typeof gamesTable.$inferInsert> = {};
        for (const field of presentFields) {
          patch = { ...patch, ...linkFieldPatch(field, payload[field]) };
        }

        await tx
          .update(gamesTable)
          .set({ ...patch, updatedAt: new Date() })
          .where(and(eq(gamesTable.id, change.gameId), eq(gamesTable.ownerId, ownerId)));
        applied += 1;
        continue;
      }

      if (kind === 'field_update') {
        if (change.gameId === null) throw new Error('field_update change is missing a gameId');
        const field = assertSyncableField(payload.field);
        await tx
          .update(gamesTable)
          .set({ ...fieldUpdatePatch(field, payload.to), updatedAt: new Date() })
          .where(and(eq(gamesTable.id, change.gameId), eq(gamesTable.ownerId, ownerId)));
        applied += 1;
        continue;
      }

      if (kind === 'new_game') {
        // Branches on WHICH identity field the payload carries, not on the
        // run's own `source` column — `steamAppid` (number) and
        // `psnTitleId` (string) are each other's proof of which shape this
        // is, and neither planner ever produces a payload naming both.
        if (typeof payload.steamAppid === 'number') {
          const steamAppid = payload.steamAppid;
          const hoursTenths = payload.hoursTenths;
          if (typeof hoursTenths !== 'number') {
            throw new Error('new_game change payload is missing a numeric hoursTenths');
          }
          await tx.insert(gamesTable).values({
            ownerId,
            title: change.title,
            platform: 'steam',
            steamAppid,
            hoursTenths,
            // A game arriving with recorded hours is already underway or
            // done; one at zero was just discovered and has not been played
            // yet. New rows never land in 'playing' — sync cannot know that.
            status: hoursTenths > 0 ? 'completed' : 'backlog',
          });
          created += 1;
          continue;
        }

        if (typeof payload.psnTitleId === 'string' && payload.psnTitleId !== '') {
          const psnTitleId = payload.psnTitleId;
          const hoursTenths = payload.hoursTenths;
          if (typeof hoursTenths !== 'number') {
            throw new Error('new_game change payload is missing a numeric hoursTenths');
          }
          const platform = payload.platform;
          const firstPlayedYear = payload.firstPlayedYear;
          const lastPlayedAt = payload.lastPlayedAt;
          const psnNpCommunicationId = payload.psnNpCommunicationId;
          const achievementsUnlocked = payload.achievementsUnlocked;
          const achievementsTotal = payload.achievementsTotal;
          const platinum = payload.platinum;

          await tx.insert(gamesTable).values({
            ownerId,
            title: change.title,
            psnTitleId,
            hoursTenths,
            status: hoursTenths > 0 ? 'completed' : 'backlog',
            ...(isGamePlatform(platform) ? { platform } : {}),
            ...(typeof firstPlayedYear === 'number' ? { firstPlayedYear } : {}),
            ...(typeof lastPlayedAt === 'string' ? { lastPlayedAt: new Date(lastPlayedAt) } : {}),
            ...(typeof psnNpCommunicationId === 'string' && psnNpCommunicationId !== '' ? { psnNpCommunicationId } : {}),
            ...(typeof achievementsUnlocked === 'number' ? { achievementsUnlocked } : {}),
            ...(typeof achievementsTotal === 'number' ? { achievementsTotal } : {}),
            ...(typeof platinum === 'boolean' ? { platinum } : {}),
          });
          created += 1;
          continue;
        }

        throw new Error('new_game change payload is missing a steamAppid or psnTitleId');
      }
    }

    await tx
      .update(gameSyncRuns)
      .set({ status: 'committed', updatedAt: new Date() })
      .where(and(eq(gameSyncRuns.id, runId), eq(gameSyncRuns.ownerId, ownerId)));

    return { applied, created };
  });
}
