/**
 * Owner-scoped data access for `game_play_years`.
 *
 * Same discipline as `src/server/db/games/games.ts`: `ownerId` is the first
 * parameter of every function and goes into every WHERE.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { getDb } from '@/server/db';
import { gamePlayYears, games } from '@/server/db/schema';
import type { PlayYearRow } from '@/server/games/play-years';

/** Every split row the owner has, for the stats page's single query. */
export async function listPlayYears(ownerId: string): Promise<PlayYearRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      gameId: gamePlayYears.gameId,
      year: gamePlayYears.year,
      hoursTenths: gamePlayYears.hoursTenths,
    })
    .from(gamePlayYears)
    .where(eq(gamePlayYears.ownerId, ownerId))
    .orderBy(asc(gamePlayYears.gameId), asc(gamePlayYears.year));

  return rows;
}

/**
 * Sum of each game's `game_play_years` rows, for a whole chunk of games in
 * ONE query — used by the Steam sync engine (src/features/games/sync/sync-actions.ts)
 * so a chunk of `CHUNK_SIZE` games costs one query, not `CHUNK_SIZE` of them.
 * A game with no split rows at all is simply absent from the returned map —
 * the caller decides what "no split" means (`null`, in `StoredGameForSync`).
 */
export async function sumPlayYearsForGames(ownerId: string, gameIds: readonly string[]): Promise<Map<string, number>> {
  if (gameIds.length === 0) return new Map();

  const db = getDb();
  const rows = await db
    .select({
      gameId: gamePlayYears.gameId,
      totalTenths: sql<number>`sum(${gamePlayYears.hoursTenths})::int`,
    })
    .from(gamePlayYears)
    .where(and(eq(gamePlayYears.ownerId, ownerId), inArray(gamePlayYears.gameId, gameIds)))
    .groupBy(gamePlayYears.gameId);

  return new Map(rows.map((row) => [row.gameId, row.totalTenths]));
}

export async function listPlayYearsForGame(ownerId: string, gameId: string): Promise<PlayYearRow[]> {
  const db = getDb();
  return db
    .select({
      gameId: gamePlayYears.gameId,
      year: gamePlayYears.year,
      hoursTenths: gamePlayYears.hoursTenths,
    })
    .from(gamePlayYears)
    .where(and(eq(gamePlayYears.ownerId, ownerId), eq(gamePlayYears.gameId, gameId)))
    .orderBy(asc(gamePlayYears.year));
}

/**
 * Delete-then-insert rather than a diff. A split is at most a handful of rows
 * and is always edited as a whole in the UI, so reconciling row-by-row would
 * be more code for no behavioural difference. Wrapped in a transaction so a
 * failed insert cannot leave the game with no split at all.
 *
 * The game is re-checked against `ownerId` inside the transaction: passing a
 * game id belonging to someone else must be a silent no-op, never a write.
 */
export async function replacePlayYears(
  ownerId: string,
  gameId: string,
  rows: readonly { readonly year: number; readonly hoursTenths: number }[],
): Promise<void> {
  const db = getDb();

  await db.transaction(async (tx) => {
    const owned = await tx
      .select({ id: games.id })
      .from(games)
      .where(and(eq(games.id, gameId), eq(games.ownerId, ownerId)))
      .limit(1);

    if (owned.length === 0) return;

    await tx
      .delete(gamePlayYears)
      .where(and(eq(gamePlayYears.ownerId, ownerId), eq(gamePlayYears.gameId, gameId)));

    if (rows.length === 0) return;

    await tx.insert(gamePlayYears).values(
      rows.map((row) => ({
        ownerId,
        gameId,
        year: row.year,
        hoursTenths: row.hoursTenths,
      })),
    );
  });
}
