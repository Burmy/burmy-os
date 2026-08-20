/**
 * The one place a game-metadata HTTP request happens.
 *
 * Isolated from `src/server/games/metadata.ts` so all the URL building and
 * response shaping stays pure and unit-testable. Failure is ALWAYS soft: cover
 * art is a nicety, and a RAWG outage must never block adding a game to the
 * library.
 */

import { buildSearchUrl, toSuggestions, type GameSuggestion } from '@/server/games/metadata';

const TIMEOUT_MS = 5_000;

export async function searchGames(query: string): Promise<GameSuggestion[]> {
  const apiKey = process.env.RAWG_API_KEY;
  // Not configured is a normal state, not an error: the app is fully usable
  // without cover art, and the test suite must pass with no key present.
  if (apiKey === undefined || apiKey === '') return [];
  if (query.trim() === '') return [];

  try {
    const response = await fetch(buildSearchUrl(query, apiKey), {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return [];
    return toSuggestions(await response.json());
  } catch {
    // Network error, timeout, or malformed JSON — all mean "no suggestions",
    // never a thrown error that would break the add-game form.
    return [];
  }
}
