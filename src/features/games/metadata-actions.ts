'use server';

import { z } from 'zod';

import { requireOwner } from '@/server/auth/owner';
import { searchGames } from '@/server/db/games/igdb';
import type { GameSuggestion } from '@/server/games/metadata';

/**
 * Cover-art/metadata lookup for the add/edit form's search-as-you-type
 * field. `requireOwner()` first, like every Server Action. `min(3)` mirrors
 * the client's own debounce threshold (`SEARCH_MIN_LENGTH` in
 * `game-dialog.tsx`) as defense-in-depth, not the only place it's enforced.
 */
export async function searchGameMetadataAction(query: string): Promise<GameSuggestion[]> {
  await requireOwner();
  const parsed = z.string().trim().min(3).max(200).safeParse(query);
  if (!parsed.success) return [];
  return searchGames(parsed.data);
}
