'use server';

import { z } from 'zod';

import { requireOwner } from '@/server/auth/owner';
import { fetchGameTrophies, type PsnFailure } from '@/server/db/games/psn-client';
import { GameNotFoundError } from '@/server/db/games/errors';
import { getGame } from '@/server/db/games/games';
import { npServiceNameForPlatform, type Trophy } from '@/server/games/psn';

const idSchema = z.string().uuid();

export type TrophyFetchResult = { readonly ok: true; readonly trophies: readonly Trophy[] } | { readonly ok: false; readonly reason: PsnFailure | 'not_linked' };

/**
 * Fetches one game's full trophy detail, live, every call — no caching
 * table, mirroring `fetchUpcomingGames()`'s own contract (see
 * `src/server/games/psn.ts`'s "PER-GAME TROPHY DETAIL" header). Re-derives
 * `psnNpCommunicationId`/`platform` from a fresh `getGame` lookup itself
 * rather than trusting anything the client could pass in — the same
 * re-fetch-before-trusting shape `updateGameAction` already uses. Read-only:
 * no `revalidatePath`, nothing is written.
 */
export async function fetchGameTrophiesAction(gameId: string): Promise<TrophyFetchResult> {
  const owner = await requireOwner();
  const id = idSchema.parse(gameId);

  let game;
  try {
    game = await getGame(owner.userId, id);
  } catch (error) {
    // A game deleted (by the owner, in another tab) between page load and
    // clicking the Trophies tab is the only realistic way this throws —
    // treat it the same as any other "couldn't reach the data" failure
    // rather than adding a fourth failure code for a rare edge case.
    if (error instanceof GameNotFoundError) return { ok: false, reason: 'unavailable' };
    throw error;
  }

  if (game.psnNpCommunicationId === null) return { ok: false, reason: 'not_linked' };

  const result = await fetchGameTrophies(game.psnNpCommunicationId, npServiceNameForPlatform(game.platform));
  if (typeof result === 'string') return { ok: false, reason: result };
  return { ok: true, trophies: result };
}
