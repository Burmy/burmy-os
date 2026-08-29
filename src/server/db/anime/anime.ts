/**
 * Owner-scoped data access for `anime`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `ownerId` IS THE FIRST PARAMETER OF EVERY FUNCTION AND GOES INTO EVERY WHERE.
 *
 * The same structural discipline `db/games` and `db/finance` hold, and for the
 * same reason: there is exactly one owner today, so nothing about a forgotten
 * scope would fail loudly. It has to be structural rather than remembered.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { and, asc, count, desc, eq, gt, sql } from 'drizzle-orm';

import { getDb } from '@/server/db';
import { anime as animeTable, animeSeries } from '@/server/db/schema';
import type { AnimeFormat, AnimeSeason, AnimeSource, AnimeStatus } from '@/server/anime/taxonomy';
import { AnimeNotFoundError } from './errors';

export interface Anime {
  readonly id: string;
  readonly seriesId: string | null;
  readonly anilistMediaId: number | null;
  readonly titleRomaji: string;
  readonly titleEnglish: string | null;
  readonly format: AnimeFormat | null;
  readonly status: AnimeStatus;
  readonly episodes: number | null;
  readonly progress: number;
  readonly repeatCount: number;
  readonly durationMinutes: number | null;
  readonly season: AnimeSeason | null;
  readonly seasonYear: number | null;
  readonly studio: string | null;
  readonly genre: string | null;
  readonly source: AnimeSource | null;
  readonly synopsis: string | null;
  readonly coverUrl: string | null;
  readonly notes: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** `titleRomaji` is the only required field — AniList always has one, and it is the row's identity when nothing else is known. */
export interface AnimeInput {
  readonly titleRomaji: string;
  readonly seriesId?: string | null;
  readonly anilistMediaId?: number | null;
  readonly titleEnglish?: string | null;
  readonly format?: AnimeFormat | null;
  readonly status?: AnimeStatus;
  readonly episodes?: number | null;
  readonly progress?: number;
  readonly repeatCount?: number;
  readonly durationMinutes?: number | null;
  readonly season?: AnimeSeason | null;
  readonly seasonYear?: number | null;
  readonly studio?: string | null;
  readonly genre?: string | null;
  readonly source?: AnimeSource | null;
  readonly synopsis?: string | null;
  readonly coverUrl?: string | null;
  readonly notes?: string | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
}

/** Every `as` cast in one place, so a widened column is a single edit. */
function rowToAnime(row: typeof animeTable.$inferSelect): Anime {
  return {
    id: row.id,
    seriesId: row.seriesId,
    anilistMediaId: row.anilistMediaId,
    titleRomaji: row.titleRomaji,
    titleEnglish: row.titleEnglish,
    format: row.format as AnimeFormat | null,
    status: row.status as AnimeStatus,
    episodes: row.episodes,
    progress: row.progress,
    repeatCount: row.repeatCount,
    durationMinutes: row.durationMinutes,
    season: row.season as AnimeSeason | null,
    seasonYear: row.seasonYear,
    studio: row.studio,
    genre: row.genre,
    source: row.source as AnimeSource | null,
    synopsis: row.synopsis,
    coverUrl: row.coverUrl,
    notes: row.notes,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The whole library.
 *
 * Ordered by recency of watching, then title — `completed_at` first, falling
 * back to `started_at`, so a show finished last week outranks one started years
 * ago. `nulls last` is load-bearing: Postgres DESC defaults to NULLS FIRST,
 * which would float every untouched Planning entry above everything actually
 * watched.
 */
export async function listAnime(ownerId: string): Promise<Anime[]> {
  const rows = await getDb()
    .select()
    .from(animeTable)
    .where(eq(animeTable.ownerId, ownerId))
    .orderBy(
      sql`coalesce(${animeTable.completedAt}, ${animeTable.startedAt}) desc nulls last`,
      asc(animeTable.titleRomaji),
    );

  return rows.map(rowToAnime);
}

/** @throws AnimeNotFoundError for a missing row AND for one belonging to someone else. */
export async function getAnime(ownerId: string, id: string): Promise<Anime> {
  const [row] = await getDb()
    .select()
    .from(animeTable)
    .where(and(eq(animeTable.ownerId, ownerId), eq(animeTable.id, id)))
    .limit(1);

  if (!row) throw new AnimeNotFoundError();
  return rowToAnime(row);
}

export async function countAnime(ownerId: string): Promise<number> {
  const [row] = await getDb().select({ n: count() }).from(animeTable).where(eq(animeTable.ownerId, ownerId));
  return row?.n ?? 0;
}

export async function createAnime(ownerId: string, input: AnimeInput): Promise<Anime> {
  const [row] = await getDb()
    .insert(animeTable)
    .values({ ownerId, ...input })
    .returning();

  if (!row) throw new AnimeNotFoundError();
  return rowToAnime(row);
}

/**
 * Drizzle's `.set()` writes only the keys present in the object, which is what
 * lets a caller patch one column without restating the row.
 *
 * `updatedAt` is set by hand on every write — there is no database trigger.
 */
export async function updateAnime(ownerId: string, id: string, input: Partial<AnimeInput>): Promise<Anime> {
  const [row] = await getDb()
    .update(animeTable)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(animeTable.ownerId, ownerId), eq(animeTable.id, id)))
    .returning();

  if (!row) throw new AnimeNotFoundError();
  return rowToAnime(row);
}

export async function deleteAnime(ownerId: string, id: string): Promise<void> {
  const deleted = await getDb()
    .delete(animeTable)
    .where(and(eq(animeTable.ownerId, ownerId), eq(animeTable.id, id)))
    .returning({ id: animeTable.id });

  if (!deleted[0]) throw new AnimeNotFoundError();
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync reads
// ─────────────────────────────────────────────────────────────────────────────

/** The narrow projection `planLinkedAnimeChanges` consumes — selected explicitly so the planner's input cannot silently widen. */
export interface AnimeForSync {
  readonly id: string;
  readonly title: string;
  readonly anilistMediaId: number | null;
  readonly status: AnimeStatus;
  readonly progress: number;
  readonly repeatCount: number;
  readonly episodes: number | null;
  readonly durationMinutes: number | null;
  readonly studio: string | null;
  readonly genre: string | null;
  readonly coverUrl: string | null;
}

const SYNC_PROJECTION = {
  id: animeTable.id,
  title: animeTable.titleRomaji,
  anilistMediaId: animeTable.anilistMediaId,
  status: animeTable.status,
  progress: animeTable.progress,
  repeatCount: animeTable.repeatCount,
  episodes: animeTable.episodes,
  durationMinutes: animeTable.durationMinutes,
  studio: animeTable.studio,
  genre: animeTable.genre,
  coverUrl: animeTable.coverUrl,
} as const;

/**
 * One page of the library, KEYSET-paginated by `id`.
 *
 * Keyset rather than OFFSET for the reason the Games engine documents at
 * length: `id` is a random UUID, not a sequence, so a row inserted or deleted
 * mid-run shifts an OFFSET page and either strands the run short of `total`
 * forever or re-stages an already-processed row. `id > lastId` cannot do
 * either.
 */
export async function listAnimeChunk(
  ownerId: string,
  afterId: string | null,
  limit: number,
): Promise<AnimeForSync[]> {
  const filters = [eq(animeTable.ownerId, ownerId)];
  if (afterId !== null) filters.push(gt(animeTable.id, afterId));

  const rows = await getDb()
    .select(SYNC_PROJECTION)
    .from(animeTable)
    .where(and(...filters))
    .orderBy(asc(animeTable.id))
    .limit(limit);

  return rows.map((row) => ({ ...row, status: row.status as AnimeStatus }));
}

/**
 * Every AniList id the library already holds.
 *
 * Read at the END of a run to decide which AniList entries have no row yet.
 * It has to be a fresh read rather than a tally kept during the walk: staging
 * never writes to `anime`, so a `link` staged three chunks ago is still
 * invisible in this column — the same reason `matchedSteamAppids` re-reads.
 */
export async function listLinkedAnilistIds(ownerId: string): Promise<Set<number>> {
  const rows = await getDb()
    .select({ anilistMediaId: animeTable.anilistMediaId })
    .from(animeTable)
    .where(eq(animeTable.ownerId, ownerId));

  return new Set(rows.map((row) => row.anilistMediaId).filter((id): id is number => id !== null));
}

// ─────────────────────────────────────────────────────────────────────────────
// Series
// ─────────────────────────────────────────────────────────────────────────────

export interface AnimeSeriesRow {
  readonly id: string;
  readonly title: string;
  readonly coverUrl: string | null;
  readonly anilistParentId: number | null;
}

export async function listSeries(ownerId: string): Promise<AnimeSeriesRow[]> {
  return getDb()
    .select({
      id: animeSeries.id,
      title: animeSeries.title,
      coverUrl: animeSeries.coverUrl,
      anilistParentId: animeSeries.anilistParentId,
    })
    .from(animeSeries)
    .where(eq(animeSeries.ownerId, ownerId))
    .orderBy(asc(animeSeries.title));
}

/** Most recently watched first — what the library's "recent" ordering reads. */
export async function listRecentAnime(ownerId: string, limit: number): Promise<Anime[]> {
  const rows = await getDb()
    .select()
    .from(animeTable)
    .where(eq(animeTable.ownerId, ownerId))
    .orderBy(desc(animeTable.updatedAt))
    .limit(limit);

  return rows.map(rowToAnime);
}
