/**
 * AniList sync runs, their staged changes, and the ONE function allowed to
 * apply them to `anime`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOTHING OUTSIDE `commitAnimeSyncRun` WRITES TO `anime`.
 *
 * Everything a run does before the owner approves it produces
 * `anime_sync_changes` rows and nothing else. That is not a convention to
 * remember — it falls out of the design, because no other function in this
 * module imports the `anime` table's write path at all.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { and, asc, eq, sql } from 'drizzle-orm';

import { getDb } from '@/server/db';
import { anime as animeTable, animeSyncChanges, animeSyncRuns } from '@/server/db/schema';
import type { AnimeSyncChangeKind, PlannedAnimeChange } from '@/server/anime/sync-plan';
import { SYNCABLE_ANIME_FIELDS, defaultSelected } from '@/server/anime/sync-plan';
import {
  isAnimeFormat,
  isAnimeSeason,
  isAnimeSource,
  isAnimeStatus,
} from '@/server/anime/taxonomy';
import {
  AnimeSyncRunAlreadyCommittedError,
  AnimeSyncRunNotFoundError,
  AnimeSyncRunNotReadyError,
  isUniqueViolation,
} from './errors';

export interface AnimeSyncRun {
  readonly id: string;
  readonly status: string;
  readonly cursor: number;
  readonly total: number;
  readonly lastAnimeId: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: Date;
}

export interface AnimeSyncChange {
  readonly id: string;
  readonly animeId: string | null;
  readonly kind: string;
  readonly title: string;
  readonly selected: boolean;
  readonly payload: Record<string, unknown>;
}

export async function createAnimeSyncRun(ownerId: string, total: number, snapshot: unknown): Promise<string> {
  const [row] = await getDb()
    .insert(animeSyncRuns)
    .values({ ownerId, total, snapshot })
    .returning({ id: animeSyncRuns.id });

  if (!row) throw new AnimeSyncRunNotFoundError();
  return row.id;
}

export async function getAnimeSyncRun(ownerId: string, runId: string): Promise<AnimeSyncRun | null> {
  const [row] = await getDb()
    .select({
      id: animeSyncRuns.id,
      status: animeSyncRuns.status,
      cursor: animeSyncRuns.cursor,
      total: animeSyncRuns.total,
      lastAnimeId: animeSyncRuns.lastAnimeId,
      errorMessage: animeSyncRuns.errorMessage,
      createdAt: animeSyncRuns.createdAt,
    })
    .from(animeSyncRuns)
    .where(and(eq(animeSyncRuns.ownerId, ownerId), eq(animeSyncRuns.id, runId)))
    .limit(1);

  return row ?? null;
}

/** The AniList response captured at run start. `unknown` on the way out — the caller re-narrows it, never trusting stored third-party JSON any more than a live response. */
export async function getAnimeSyncSnapshot(ownerId: string, runId: string): Promise<unknown> {
  const [row] = await getDb()
    .select({ snapshot: animeSyncRuns.snapshot })
    .from(animeSyncRuns)
    .where(and(eq(animeSyncRuns.ownerId, ownerId), eq(animeSyncRuns.id, runId)))
    .limit(1);

  return row?.snapshot ?? null;
}

/**
 * Stages a chunk's changes and advances the bookmark.
 *
 * The cursor UPDATE is NOT gated on there being changes to insert: a chunk
 * where nothing diverged still moved the walk forward, and skipping the update
 * would make the run re-read the same page forever.
 */
export async function appendAnimeSyncChanges(
  ownerId: string,
  runId: string,
  changes: readonly PlannedAnimeChange[],
  cursor: number,
  lastAnimeId: string | null,
): Promise<void> {
  const db = getDb();

  if (changes.length > 0) {
    await db.insert(animeSyncChanges).values(
      changes.map((change) => ({
        ownerId,
        runId,
        animeId: change.animeId,
        kind: change.kind,
        title: change.title,
        // Computed per change rather than left to the column default, because
        // an advisory item must never arrive pre-selected.
        selected: defaultSelected(change.kind),
        payload: change.payload,
      })),
    );
  }

  await db
    .update(animeSyncRuns)
    .set({ cursor, lastAnimeId, updatedAt: new Date() })
    .where(and(eq(animeSyncRuns.ownerId, ownerId), eq(animeSyncRuns.id, runId)));
}

/**
 * Marks a run finished.
 *
 * NULLS THE SNAPSHOT once the run reaches `ready`: nothing reads it after the
 * walk ends, and it is by far the largest column in the module — a few hundred
 * KB of jsonb per run, kept forever. Not an optimisation; declining to store
 * data with no reader.
 */
export async function finishAnimeSyncRun(
  ownerId: string,
  runId: string,
  status: 'ready' | 'failed' | 'cancelled',
  errorMessage: string | null = null,
): Promise<void> {
  await getDb()
    .update(animeSyncRuns)
    .set({ status, errorMessage, snapshot: null, updatedAt: new Date() })
    .where(and(eq(animeSyncRuns.ownerId, ownerId), eq(animeSyncRuns.id, runId)));
}

export async function listAnimeSyncChanges(ownerId: string, runId: string): Promise<AnimeSyncChange[]> {
  const rows = await getDb()
    .select({
      id: animeSyncChanges.id,
      animeId: animeSyncChanges.animeId,
      kind: animeSyncChanges.kind,
      title: animeSyncChanges.title,
      selected: animeSyncChanges.selected,
      payload: animeSyncChanges.payload,
    })
    .from(animeSyncChanges)
    .where(and(eq(animeSyncChanges.ownerId, ownerId), eq(animeSyncChanges.runId, runId)))
    .orderBy(asc(animeSyncChanges.createdAt));

  return rows.map((row) => ({ ...row, payload: (row.payload ?? {}) as Record<string, unknown> }));
}

export async function setAnimeSyncChangeSelected(
  ownerId: string,
  changeId: string,
  selected: boolean,
): Promise<void> {
  await getDb()
    .update(animeSyncChanges)
    .set({ selected })
    .where(and(eq(animeSyncChanges.ownerId, ownerId), eq(animeSyncChanges.id, changeId)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Commit
// ─────────────────────────────────────────────────────────────────────────────

function assertSyncableField(field: unknown): asserts field is (typeof SYNCABLE_ANIME_FIELDS)[number] {
  if (typeof field === 'string' && (SYNCABLE_ANIME_FIELDS as readonly string[]).includes(field)) return;
  throw new Error(`Refusing to apply an unknown field: ${String(field)}`);
}

/**
 * One field's patch, built by an EXHAUSTIVE SWITCH rather than a computed key.
 *
 * `{ [field]: value }` would still typecheck after `assertSyncableField`, which
 * is exactly why it is not used: the switch — not the whitelist check alone —
 * is what makes "interpolate an arbitrary column name" structurally impossible
 * to reintroduce later. Each case also validates its own value's shape, because
 * a payload is stored JSON and stored JSON is still untrusted.
 */
function fieldPatch(
  field: (typeof SYNCABLE_ANIME_FIELDS)[number],
  to: unknown,
): Partial<typeof animeTable.$inferInsert> {
  const num = (value: unknown): number | null =>
    typeof value === 'number' && Number.isInteger(value) ? value : null;
  const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

  switch (field) {
    case 'status':
      return isAnimeStatus(to) ? { status: to } : {};
    case 'progress': {
      const value = num(to);
      return value === null ? {} : { progress: Math.max(0, value) };
    }
    case 'repeatCount': {
      const value = num(to);
      return value === null ? {} : { repeatCount: Math.max(0, value) };
    }
    case 'episodes':
      return { episodes: num(to) };
    case 'durationMinutes':
      return { durationMinutes: num(to) };
    case 'studio':
      return { studio: str(to) };
    case 'genre':
      return { genre: str(to) };
    case 'coverUrl':
      return { coverUrl: str(to) };
  }
}

/** A `new_anime` payload into insert values. Every field `typeof`-checked; nothing is cast. */
function newAnimeValues(ownerId: string, payload: Record<string, unknown>): typeof animeTable.$inferInsert | null {
  const title = payload.titleRomaji;
  if (typeof title !== 'string' || title === '') return null;

  const num = (value: unknown): number | null =>
    typeof value === 'number' && Number.isInteger(value) ? value : null;
  const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

  return {
    ownerId,
    titleRomaji: title,
    titleEnglish: str(payload.titleEnglish),
    anilistMediaId: num(payload.anilistMediaId),
    status: isAnimeStatus(payload.status) ? payload.status : 'planning',
    progress: Math.max(0, num(payload.progress) ?? 0),
    repeatCount: Math.max(0, num(payload.repeatCount) ?? 0),
    episodes: num(payload.episodes),
    durationMinutes: num(payload.durationMinutes),
    format: isAnimeFormat(payload.format) ? payload.format : null,
    season: isAnimeSeason(payload.season) ? payload.season : null,
    seasonYear: num(payload.seasonYear),
    studio: str(payload.studio),
    genre: str(payload.genre),
    source: isAnimeSource(payload.source) ? payload.source : null,
    synopsis: str(payload.synopsis),
    coverUrl: str(payload.coverUrl),
    startedAt: str(payload.startedAt),
    completedAt: str(payload.completedAt),
  };
}

/** `series_hint` is advisory and applies nothing — a separate guard, not a re-derivation of the staging default. */
const APPLIES_NOTHING: ReadonlySet<AnimeSyncChangeKind> = new Set(['series_hint']);

const COMMIT_ORDER: Record<string, number> = { link: 0, field_update: 1, new_anime: 2, series_hint: 3 };

export interface AnimeCommitResult {
  readonly applied: number;
  readonly created: number;
  readonly skipped: number;
}

/**
 * Applies an approved run. The ONE place this module writes to `anime`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE TRANSACTION, because the owner approved a SET of changes together —
 * applying half and failing on the rest leaves the library in a state nobody
 * approved.
 *
 * AN ADVISORY LOCK AS THE FIRST STATEMENT, keyed to the run. Under READ
 * COMMITTED a double-click can otherwise run two commits of the same run
 * concurrently. Keyed on a DIFFERENT name from the Games commit's, so an anime
 * commit and a games commit never serialise against each other.
 *
 * A STALE `new_anime` IS SKIPPED VIA SAVEPOINT, not thrown. A row created since
 * the run was staged collides on `(owner, anilist_media_id)`. A plain try/catch
 * is not enough — Postgres poisons the enclosing transaction the instant any
 * statement errors, so the failed insert has to be rolled back to a SAVEPOINT
 * (`tx.transaction`) for the rest of the commit to survive. And the error is
 * recognised with `isUniqueViolation()`, which walks the `cause` chain, never
 * `error.code === '23505'` — Drizzle wraps driver errors and the naive check
 * silently never matches.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export async function commitAnimeSyncRun(ownerId: string, runId: string): Promise<AnimeCommitResult> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('burmy_anime_sync_commit'), hashtext(${runId}))`);

    const [run] = await tx
      .select({ status: animeSyncRuns.status })
      .from(animeSyncRuns)
      .where(and(eq(animeSyncRuns.ownerId, ownerId), eq(animeSyncRuns.id, runId)))
      .limit(1);

    if (!run) throw new AnimeSyncRunNotFoundError();
    if (run.status === 'committed') throw new AnimeSyncRunAlreadyCommittedError();
    if (run.status !== 'ready') throw new AnimeSyncRunNotReadyError(run.status);

    const changes = await tx
      .select({
        animeId: animeSyncChanges.animeId,
        kind: animeSyncChanges.kind,
        selected: animeSyncChanges.selected,
        payload: animeSyncChanges.payload,
        createdAt: animeSyncChanges.createdAt,
      })
      .from(animeSyncChanges)
      .where(and(eq(animeSyncChanges.ownerId, ownerId), eq(animeSyncChanges.runId, runId)))
      .orderBy(asc(animeSyncChanges.createdAt));

    // Stable sort, so same-kind changes keep their staging order.
    const ordered = [...changes].sort(
      (a, b) => (COMMIT_ORDER[a.kind] ?? 99) - (COMMIT_ORDER[b.kind] ?? 99),
    );

    let applied = 0;
    let created = 0;
    let skipped = 0;

    for (const change of ordered) {
      if (!change.selected) continue;
      if (APPLIES_NOTHING.has(change.kind as AnimeSyncChangeKind)) continue;

      const payload = (change.payload ?? {}) as Record<string, unknown>;

      if (change.kind === 'new_anime') {
        const values = newAnimeValues(ownerId, payload);
        if (values === null) continue;

        try {
          // A real SAVEPOINT — see the doc comment.
          await tx.transaction(async (savepoint) => {
            await savepoint.insert(animeTable).values(values);
          });
          created += 1;
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          skipped += 1;
        }
        continue;
      }

      if (change.animeId === null) continue;

      let patch: Partial<typeof animeTable.$inferInsert> = {};

      if (change.kind === 'link') {
        const id = payload.anilistMediaId;
        if (typeof id !== 'number' || !Number.isInteger(id)) continue;
        patch = { anilistMediaId: id };
      } else if (change.kind === 'field_update') {
        assertSyncableField(payload.field);
        patch = fieldPatch(payload.field, payload.to);
      } else {
        continue;
      }

      if (Object.keys(patch).length === 0) continue;

      await tx
        .update(animeTable)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(animeTable.ownerId, ownerId), eq(animeTable.id, change.animeId)));

      applied += 1;
    }

    await tx
      .update(animeSyncRuns)
      .set({ status: 'committed', updatedAt: new Date() })
      .where(and(eq(animeSyncRuns.ownerId, ownerId), eq(animeSyncRuns.id, runId)));

    return { applied, created, skipped };
  });
}
