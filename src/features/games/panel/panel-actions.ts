'use server';

import { z } from 'zod';

import { requireOwner } from '@/server/auth/owner';
import { GameNotFoundError } from '@/server/db/games/errors';
import {
  type CollectionMember,
  type Game,
  getGame,
  listCollectionCandidates,
  listCollectionMembers,
  listCollectionOptions,
} from '@/server/db/games/games';
import { PLATFORM_LABELS } from '@/server/games/taxonomy';

/**
 * Everything the side panel shows for one game — the same four reads the
 * old `/games/[id]` page made, behind one Server Action so the panel can
 * fetch (and re-fetch after every save) without a route.
 */
export interface GamePanelData {
  readonly game: Game;
  /** The games INSIDE this one. Non-empty exactly when this row is a collection. */
  readonly members: readonly CollectionMember[];
  /** The collection this game sits in, or `null`. */
  readonly collection: { readonly id: string; readonly title: string } | null;
  /** Rows this game could be filed into — see `listCollectionOptions`. */
  readonly collectionOptions: readonly { readonly id: string; readonly title: string }[];
  /** Games that could be added INTO this one — see `listCollectionCandidates`. */
  readonly collectionCandidates: readonly {
    readonly id: string;
    readonly title: string;
    readonly subtitle: string;
  }[];
}

const idSchema = z.string().uuid();

/**
 * `null` for a malformed id, a missing row, or another owner's row — one
 * answer for all three, so a crafted id cannot probe for other owners' games
 * (the same reasoning as `GameNotFoundError` itself). The panel treats
 * `null` as "this game is gone" and closes.
 */
export async function getGamePanelAction(id: string): Promise<GamePanelData | null> {
  const owner = await requireOwner();

  const parsed = idSchema.safeParse(id);
  if (!parsed.success) return null;

  let game: Game;
  try {
    game = await getGame(owner.userId, parsed.data);
  } catch (error) {
    if (error instanceof GameNotFoundError) return null;
    throw error;
  }

  // `collectionOptions` and `collectionCandidates` are fetched
  // unconditionally rather than branched on "is this a collection yet" —
  // each is a two/three-column read over ~190 rows, and a collection only
  // exists once the first game is filed in, so nothing can gate them.
  const [members, collectionOptions, candidates] = await Promise.all([
    listCollectionMembers(owner.userId, game.id),
    listCollectionOptions(owner.userId, game.id),
    listCollectionCandidates(owner.userId, game.id),
  ]);

  // Resolved from the options list already in hand rather than a fourth
  // query — `collectionId` always points at a row that is itself
  // collection-less, which is precisely what that list holds.
  const collection =
    game.collectionId === null
      ? null
      : (collectionOptions.find((option) => option.id === game.collectionId) ?? null);

  return {
    game,
    members,
    collection,
    collectionOptions,
    collectionCandidates: candidates.map((row) => ({
      id: row.id,
      title: row.title,
      subtitle: PLATFORM_LABELS[row.platform],
    })),
  };
}
