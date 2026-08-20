'use server';

import { z } from 'zod';

import { requireOwner } from '@/server/auth/owner';
import { searchGames } from '@/server/db/games/rawg';
import type { GameSuggestion } from '@/server/games/metadata';

/** Cover-art lookup for the add/edit form. `requireOwner()` first, like every Server Action. */
export async function searchGameMetadataAction(query: string): Promise<GameSuggestion[]> {
  await requireOwner();
  const parsed = z.string().trim().min(2).max(200).safeParse(query);
  if (!parsed.success) return [];
  return searchGames(parsed.data);
}
