/**
 * The dated watch log — one row per episode AniList recorded the owner
 * finishing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LOG ROWS ARE WRITTEN DIRECTLY, NOT STAGED FOR APPROVAL.
 *
 * Everything else an AniList sync produces goes through `anime_sync_changes`
 * and waits for a click, because it proposes changing something the owner
 * might have set by hand. A log row proposes nothing: it is a dated fact about
 * the past with no owner-authored counterpart, so asking for approval would be
 * asking the owner to ratify reality. Trophies get exactly this carve-out in
 * `psn-actions.ts`, for the same reason and in the same words.
 *
 * A RE-SYNC IS AN UPSERT, KEYED ON `anilist_activity_id`.
 *
 * The partial unique index on `(owner_id, anilist_activity_id) where not null`
 * is what makes that true, and it is the whole idempotency story: the feed is
 * walked newest-first from the start every time, so without it a second sync
 * would duplicate every row it had already seen. `ON CONFLICT DO NOTHING`
 * rather than an update — an activity is immutable once posted, so there is
 * nothing to refresh, and DO NOTHING keeps the operation a single statement.
 *
 * The `where not null` half matters too: it leaves room for a hand-added entry
 * with no AniList id, and several of those must not collide with each other.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `ownerId` is the first parameter of every function and goes into every WHERE.
 */

import { and, count, desc, eq, sql } from 'drizzle-orm';

import { getDb } from '@/server/db';
import { anime as animeTable, animeWatchLog } from '@/server/db/schema';

export interface WatchLogEntry {
  readonly id: string;
  readonly animeId: string;
  readonly title: string;
  readonly coverUrl: string | null;
  readonly watchedAt: Date;
  readonly episode: number | null;
  readonly kind: string;
}

export interface WatchLogInsert {
  readonly animeId: string;
  readonly anilistActivityId: number | null;
  readonly watchedAt: Date;
  readonly episode: number | null;
  readonly kind: string;
}

/**
 * Inserts log rows, skipping any whose AniList activity is already recorded.
 * Returns how many were actually written.
 *
 * The count is the real inserted count, not the input length — that difference
 * is what lets the sync report "48 new entries" on a second run instead of
 * claiming it imported the whole feed again.
 */
export async function insertWatchLogEntries(
  ownerId: string,
  entries: readonly WatchLogInsert[],
): Promise<number> {
  if (entries.length === 0) return 0;

  const inserted = await getDb()
    .insert(animeWatchLog)
    .values(entries.map((entry) => ({ ...entry, ownerId })))
    .onConflictDoNothing({
      target: [animeWatchLog.ownerId, animeWatchLog.anilistActivityId],
      // The index is PARTIAL, so its predicate has to be repeated here or
      // Postgres cannot match the arbiter and raises "there is no unique or
      // exclusion constraint matching the ON CONFLICT specification" — an
      // error that names the clause rather than the index and reads like the
      // index is missing entirely. On `onConflictDoNothing` the option is
      // `where` (it is `setWhere` only on `onConflictDoUpdate`, where `where`
      // already means the update's own predicate).
      where: sql`${animeWatchLog.anilistActivityId} is not null`,
    })
    .returning({ id: animeWatchLog.id });

  return inserted.length;
}

/** The whole log, newest first — what the Log tab reads. */
export async function listWatchLog(ownerId: string, limit: number): Promise<WatchLogEntry[]> {
  return getDb()
    .select({
      id: animeWatchLog.id,
      animeId: animeWatchLog.animeId,
      title: animeTable.titleRomaji,
      coverUrl: animeTable.coverUrl,
      watchedAt: animeWatchLog.watchedAt,
      episode: animeWatchLog.episode,
      kind: animeWatchLog.kind,
    })
    .from(animeWatchLog)
    .innerJoin(animeTable, eq(animeWatchLog.animeId, animeTable.id))
    .where(eq(animeWatchLog.ownerId, ownerId))
    .orderBy(desc(animeWatchLog.watchedAt))
    .limit(limit);
}

/** One show's history, newest first — the section on its own page. */
export async function listWatchLogForAnime(
  ownerId: string,
  animeId: string,
  limit: number,
): Promise<WatchLogEntry[]> {
  return getDb()
    .select({
      id: animeWatchLog.id,
      animeId: animeWatchLog.animeId,
      title: animeTable.titleRomaji,
      coverUrl: animeTable.coverUrl,
      watchedAt: animeWatchLog.watchedAt,
      episode: animeWatchLog.episode,
      kind: animeWatchLog.kind,
    })
    .from(animeWatchLog)
    .innerJoin(animeTable, eq(animeWatchLog.animeId, animeTable.id))
    .where(and(eq(animeWatchLog.ownerId, ownerId), eq(animeWatchLog.animeId, animeId)))
    .orderBy(desc(animeWatchLog.watchedAt))
    .limit(limit);
}

export interface WatchLogBounds {
  readonly total: number;
  /** The oldest entry the log holds — the WATERMARK. `null` when the log is empty. */
  readonly oldest: Date | null;
  readonly newest: Date | null;
}

/**
 * How much log there is, and how far back it reaches.
 *
 * The oldest date is shown on screen as a watermark, and that is not decoration:
 * AniList's activity feed has an unknown retention, so the log is only as
 * complete as the feed was. Saying "nothing recorded before 12 Mar 2024" turns
 * a truncated history into a stated limitation instead of something that reads
 * like missing data.
 */
export async function getWatchLogBounds(ownerId: string): Promise<WatchLogBounds> {
  const [row] = await getDb()
    .select({
      total: count(),
      oldest: sql<string | null>`min(${animeWatchLog.watchedAt})`,
      newest: sql<string | null>`max(${animeWatchLog.watchedAt})`,
    })
    .from(animeWatchLog)
    .where(eq(animeWatchLog.ownerId, ownerId));

  return {
    total: row?.total ?? 0,
    oldest: row?.oldest ? new Date(row.oldest) : null,
    newest: row?.newest ? new Date(row.newest) : null,
  };
}
