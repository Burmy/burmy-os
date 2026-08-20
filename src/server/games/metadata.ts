/**
 * Game metadata shaping — cover art, genre, developer, publisher.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY RAWG AND NOT IGDB
 *
 * Both expose the same cover-art-and-genre data. RAWG authenticates with a
 * single API key in an env var; IGDB requires a Twitch developer application
 * and an OAuth client-credentials exchange with token refresh. For a
 * single-owner personal app that calls this a few times a month, the OAuth
 * lifecycle is pure operational cost with no benefit.
 *
 * This module is PURE — it builds URLs and shapes responses but never performs
 * a request. The fetch lives in `src/server/db/games/rawg.ts` so the matching
 * logic below stays testable without a network or a fake server.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const RAWG_SEARCH_ENDPOINT = 'https://api.rawg.io/api/games';

export interface GameSuggestion {
  readonly externalId: string;
  readonly title: string;
  readonly coverUrl: string | null;
  readonly genre: string | null;
  readonly developer: string | null;
  readonly publisher: string | null;
}

/**
 * Builds the query string by hand with `encodeURIComponent` rather than
 * `URLSearchParams` — `URLSearchParams` encodes spaces as `+`
 * (application/x-www-form-urlencoded), not `%20`, which RAWG's own docs use
 * and which the test above pins.
 */
export function buildSearchUrl(query: string, apiKey: string): string {
  const params = [
    `search=${encodeURIComponent(query)}`,
    `key=${encodeURIComponent(apiKey)}`,
    'page_size=6',
  ].join('&');
  return `${RAWG_SEARCH_ENDPOINT}?${params}`;
}

function firstName(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const entry = value[0];
  if (typeof entry !== 'object' || entry === null) return null;
  const name = (entry as { name?: unknown }).name;
  return typeof name === 'string' ? name : null;
}

function joinNames(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const names = value
    .map((entry) =>
      typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string'
        ? (entry as { name: string }).name
        : null,
    )
    .filter((name): name is string => name !== null);
  return names.length === 0 ? null : names.join(', ');
}

/** Defensive by construction: a third-party payload is untrusted shape, not a typed contract. */
export function toSuggestions(payload: unknown): GameSuggestion[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];

  return results.flatMap((entry): GameSuggestion[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== 'string' || record.id === undefined) return [];

    return [
      {
        externalId: String(record.id),
        title: record.name,
        coverUrl: typeof record.background_image === 'string' ? record.background_image : null,
        genre: joinNames(record.genres),
        developer: firstName(record.developers),
        publisher: firstName(record.publishers),
      },
    ];
  });
}
