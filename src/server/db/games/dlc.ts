/**
 * Owner-scoped data access for `game_dlc`.
 *
 * Same discipline as `games.ts` and `play-years.ts`: `ownerId` is the first
 * parameter of every function and goes into every WHERE. A row belonging to
 * someone else is a `GameNotFoundError`, never a confirmation that it exists.
 *
 * The model is in `src/server/games/dlc.ts` (ADDITIVE, never attributed) and
 * the two refusals that keep DLC off a collection member are in `errors.ts`.
 */

import { and, asc, eq } from 'drizzle-orm';

import { getDb } from '@/server/db';
import { gameDlc, games } from '@/server/db/schema';
import type { GameDlcRow } from '@/server/games/dlc';

import {
  DuplicateDlcError,
  GameNotFoundError,
  isUniqueViolation,
} from './errors';

export type { GameDlcRow } from '@/server/games/dlc';

/** `name` and `year` are required on create; every figure is optional and nullable. */
export interface DlcInput {
  readonly name: string;
  readonly year: number;
  readonly hoursTenths?: number | null;
  readonly priceCents?: number | null;
  readonly achievementsUnlocked?: number | null;
  readonly achievementsTotal?: number | null;
}

const COLUMNS = {
  id: gameDlc.id,
  gameId: gameDlc.gameId,
  name: gameDlc.name,
  year: gameDlc.year,
  hoursTenths: gameDlc.hoursTenths,
  priceCents: gameDlc.priceCents,
  achievementsUnlocked: gameDlc.achievementsUnlocked,
  achievementsTotal: gameDlc.achievementsTotal,
} as const;

/** Every DLC row the owner has — one query for the stats page and the library list. */
export async function listDlc(ownerId: string): Promise<GameDlcRow[]> {
  return getDb()
    .select(COLUMNS)
    .from(gameDlc)
    .where(eq(gameDlc.ownerId, ownerId))
    .orderBy(asc(gameDlc.gameId), asc(gameDlc.year), asc(gameDlc.name));
}

export async function listDlcForGame(ownerId: string, gameId: string): Promise<GameDlcRow[]> {
  return getDb()
    .select(COLUMNS)
    .from(gameDlc)
    .where(and(eq(gameDlc.ownerId, ownerId), eq(gameDlc.gameId, gameId)))
    .orderBy(asc(gameDlc.year), asc(gameDlc.name));
}

/**
 * The game is looked up inside the same transaction as the insert, so a
 * concurrent "file this game into a collection" cannot slip between the
 * member check and the write.
 */
export async function createDlc(
  ownerId: string,
  gameId: string,
  input: DlcInput,
): Promise<GameDlcRow> {
  const db = getDb();
  try {
    return await db.transaction(async (tx) => {
      const [game] = await tx
        .select({ id: games.id, collectionId: games.collectionId })
        .from(games)
        .where(and(eq(games.id, gameId), eq(games.ownerId, ownerId)))
        .limit(1);
      if (!game) throw new GameNotFoundError();

      const [row] = await tx
        .insert(gameDlc)
        .values({
          ownerId,
          gameId,
          name: input.name,
          year: input.year,
          hoursTenths: input.hoursTenths ?? null,
          priceCents: input.priceCents ?? null,
          achievementsUnlocked: input.achievementsUnlocked ?? null,
          achievementsTotal: input.achievementsTotal ?? null,
        })
        .returning(COLUMNS);
      if (!row) throw new GameNotFoundError();
      return row;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateDlcError(input.name);
    throw error;
  }
}

/** Patches only the keys given; a key set to `null` clears that figure. */
export async function updateDlc(
  ownerId: string,
  dlcId: string,
  patch: Partial<DlcInput>,
): Promise<GameDlcRow> {
  try {
    const [row] = await getDb()
      .update(gameDlc)
      // `updatedAt` is set by hand on every write — there is no DB trigger.
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(gameDlc.ownerId, ownerId), eq(gameDlc.id, dlcId)))
      .returning(COLUMNS);
    if (!row) throw new GameNotFoundError();
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateDlcError(patch.name ?? '');
    throw error;
  }
}

export async function deleteDlc(ownerId: string, dlcId: string): Promise<void> {
  const deleted = await getDb()
    .delete(gameDlc)
    .where(and(eq(gameDlc.ownerId, ownerId), eq(gameDlc.id, dlcId)))
    .returning({ id: gameDlc.id });
  if (deleted.length === 0) throw new GameNotFoundError();
}
