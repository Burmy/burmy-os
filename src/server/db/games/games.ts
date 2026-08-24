/**
 * Owner-scoped data access for `games`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `ownerId` IS THE FIRST PARAMETER OF EVERY FUNCTION AND GOES INTO EVERY WHERE.
 *
 * Same rule Finance's data-access layer follows. There is exactly one owner
 * today, which is precisely why the discipline has to be structural rather than
 * remembered: nothing about a single-owner database will fail loudly the day a
 * query forgets its scope.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { and, asc, eq, sql } from 'drizzle-orm';

import { getDb } from '@/server/db';
import { games as gamesTable } from '@/server/db/schema';
import type { GameStatRow } from '@/server/games/stats';
import type { GameOwnership, GamePlatform, GameStatus } from '@/server/games/taxonomy';
import { DuplicateGameError, GameNotFoundError, isUniqueViolation } from './errors';

export interface Game {
  readonly id: string;
  readonly title: string;
  readonly platform: GamePlatform;
  readonly developer: string | null;
  readonly publisher: string | null;
  readonly ownership: GameOwnership | null;
  readonly priceCents: number | null;
  readonly status: GameStatus;
  readonly rating: number | null;
  readonly hoursTenths: number | null;
  readonly firstPlayedYear: number | null;
  readonly achievementsUnlocked: number | null;
  readonly achievementsTotal: number | null;
  readonly coverUrl: string | null;
  readonly genre: string | null;
  readonly notes: string | null;
  readonly platinum: boolean;
  readonly metacritic: number | null;
  readonly averagePlaytimeHours: number | null;
  readonly esrbRating: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Only `title` and `platform` are required — a backlog entry may know nothing else yet. */
export interface GameInput {
  readonly title: string;
  readonly platform: GamePlatform;
  readonly developer?: string | null;
  readonly publisher?: string | null;
  readonly ownership?: GameOwnership | null;
  readonly priceCents?: number | null;
  readonly status?: GameStatus;
  readonly rating?: number | null;
  readonly hoursTenths?: number | null;
  readonly firstPlayedYear?: number | null;
  readonly achievementsUnlocked?: number | null;
  readonly achievementsTotal?: number | null;
  readonly coverUrl?: string | null;
  readonly genre?: string | null;
  readonly notes?: string | null;
  readonly platinum?: boolean;
  readonly metacritic?: number | null;
  readonly averagePlaytimeHours?: number | null;
  readonly esrbRating?: string | null;
}

function rowToGame(row: typeof gamesTable.$inferSelect): Game {
  return {
    id: row.id,
    title: row.title,
    platform: row.platform as GamePlatform,
    developer: row.developer,
    publisher: row.publisher,
    ownership: row.ownership as GameOwnership | null,
    priceCents: row.priceCents,
    status: row.status as GameStatus,
    rating: row.rating,
    hoursTenths: row.hoursTenths,
    firstPlayedYear: row.firstPlayedYear,
    achievementsUnlocked: row.achievementsUnlocked,
    achievementsTotal: row.achievementsTotal,
    coverUrl: row.coverUrl,
    genre: row.genre,
    notes: row.notes,
    platinum: row.platinum,
    metacritic: row.metacritic,
    averagePlaytimeHours: row.averagePlaytimeHours,
    esrbRating: row.esrbRating,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface ListGamesOptions {
  readonly status?: GameStatus;
  readonly platform?: GamePlatform;
}

export async function listGames(ownerId: string, options: ListGamesOptions = {}): Promise<Game[]> {
  const filters = [eq(gamesTable.ownerId, ownerId)];
  if (options.status !== undefined) filters.push(eq(gamesTable.status, options.status));
  if (options.platform !== undefined) filters.push(eq(gamesTable.platform, options.platform));

  const rows = await getDb()
    .select()
    .from(gamesTable)
    .where(and(...filters))
    .orderBy(
      // Newest-played first. Postgres's DESC defaults to NULLS FIRST, which
      // would put every game with no recorded year — an unplayed backlog
      // entry — ABOVE everything the owner has actually played. `nulls last`
      // is load-bearing here, not decorative.
      sql`${gamesTable.firstPlayedYear} desc nulls last`,
      // ─────────────────────────────────────────────────────────────────────
      // DELIBERATE, OWNER-CHOSEN PLATFORM ORDER — NOT ALPHABETICAL.
      //
      // Only breaks ties among games with NO recorded year (the `when
      // first_played_year is null` guard): for every game that DOES have a
      // year, this branch collapses to the constant `0` and falls straight
      // through to the title tiebreak below, exactly as before. Within the
      // no-year group, rank is PS5, PS4, Steam/PC (steam and pc share a rank
      // — they render as one merged label, see PLATFORM_LABELS), PSP, then
      // anything else. Do not "tidy" this into alphabetical order or enum
      // order — it encodes a real product decision the owner asked for.
      // ─────────────────────────────────────────────────────────────────────
      sql`case when ${gamesTable.firstPlayedYear} is null then
        case ${gamesTable.platform}::text
          when 'ps5' then 0
          when 'ps4' then 1
          when 'steam' then 2
          when 'pc' then 2
          when 'psp' then 3
          else 4
        end
      else 0 end`,
      asc(gamesTable.title),
    );

  return rows.map(rowToGame);
}

export async function getGame(ownerId: string, id: string): Promise<Game> {
  const rows = await getDb()
    .select()
    .from(gamesTable)
    .where(and(eq(gamesTable.ownerId, ownerId), eq(gamesTable.id, id)))
    .limit(1);

  const row = rows[0];
  if (!row) throw new GameNotFoundError();
  return rowToGame(row);
}

export async function createGame(ownerId: string, input: GameInput): Promise<Game> {
  try {
    const rows = await getDb()
      .insert(gamesTable)
      .values({ ownerId, ...input })
      .returning();

    const row = rows[0];
    if (!row) throw new Error('Game insert returned no row');
    return rowToGame(row);
  } catch (error) {
    // Let the DATABASE decide uniqueness. A pre-check plus an insert is a race;
    // the unique index is not.
    if (isUniqueViolation(error)) throw new DuplicateGameError(input.title);
    throw error;
  }
}

export async function updateGame(ownerId: string, id: string, input: GameInput): Promise<Game> {
  try {
    const rows = await getDb()
      .update(gamesTable)
      // `updatedAt` is set by hand on every write — there is no DB trigger.
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(gamesTable.ownerId, ownerId), eq(gamesTable.id, id)))
      .returning();

    const row = rows[0];
    if (!row) throw new GameNotFoundError();
    return rowToGame(row);
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateGameError(input.title);
    throw error;
  }
}

export async function deleteGame(ownerId: string, id: string): Promise<void> {
  const deleted = await getDb()
    .delete(gamesTable)
    .where(and(eq(gamesTable.ownerId, ownerId), eq(gamesTable.id, id)))
    .returning();

  if (!deleted[0]) throw new GameNotFoundError();
}

/**
 * The narrow projection `src/server/games/stats.ts` consumes. Selecting columns
 * explicitly rather than reusing `listGames` keeps the stats layer's input
 * shape from silently widening every time a display field is added.
 */
export async function listGameStatRows(ownerId: string): Promise<GameStatRow[]> {
  const rows = await getDb()
    .select({
      id: gamesTable.id,
      title: gamesTable.title,
      platform: gamesTable.platform,
      ownership: gamesTable.ownership,
      developer: gamesTable.developer,
      publisher: gamesTable.publisher,
      genre: gamesTable.genre,
      status: gamesTable.status,
      rating: gamesTable.rating,
      hoursTenths: gamesTable.hoursTenths,
      firstPlayedYear: gamesTable.firstPlayedYear,
      achievementsUnlocked: gamesTable.achievementsUnlocked,
      achievementsTotal: gamesTable.achievementsTotal,
      platinum: gamesTable.platinum,
      metacritic: gamesTable.metacritic,
      priceCents: gamesTable.priceCents,
    })
    .from(gamesTable)
    .where(eq(gamesTable.ownerId, ownerId));

  return rows.map((row) => ({
    ...row,
    platform: row.platform as GamePlatform,
    ownership: row.ownership as GameOwnership | null,
    status: row.status as GameStatus,
  }));
}
