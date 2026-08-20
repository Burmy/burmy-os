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

export interface RawgGame {
  readonly id: number;
  readonly name: string;
  readonly background_image?: string;
  readonly released?: string;
  readonly genres?: readonly { readonly name: string }[];
  readonly developers?: readonly { readonly name: string }[];
  readonly publishers?: readonly { readonly name: string }[];
}

export interface GameSuggestion {
  readonly externalId: string;
  readonly title: string;
  readonly coverUrl: string | null;
  readonly releaseYear: number | null;
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

    const released = typeof record.released === 'string' ? Number(record.released.slice(0, 4)) : NaN;

    return [
      {
        externalId: String(record.id),
        title: record.name,
        coverUrl: typeof record.background_image === 'string' ? record.background_image : null,
        releaseYear: Number.isFinite(released) ? released : null,
        genre: joinNames(record.genres),
        developer: firstName(record.developers),
        publisher: firstName(record.publishers),
      },
    ];
  });
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * 0-1 similarity by token overlap, scored against the CANDIDATE's tokens.
 *
 * Deliberately asymmetric: the owner's log contains entries like "Uncharted:
 * Legacy of Thieves Collection - UNCHARTED 4: A Thief's End", where the extra
 * collection prefix is noise. Scoring "how much of the candidate did the query
 * cover" rather than plain Jaccard keeps that entry matching "Uncharted 4: A
 * Thief's End" instead of being penalized for the prefix.
 */
export function scoreMatch(query: string, candidate: string): number {
  const queryTokens = new Set(normalize(query).split(' ').filter(Boolean));
  const candidateTokens = normalize(candidate).split(' ').filter(Boolean);
  if (candidateTokens.length === 0 || queryTokens.size === 0) return 0;

  const covered = candidateTokens.filter((token) => queryTokens.has(token)).length;
  return covered / candidateTokens.length;
}

export function pickBestMatch(
  query: string,
  suggestions: readonly GameSuggestion[],
): { readonly suggestion: GameSuggestion; readonly confidence: number } | null {
  let best: { suggestion: GameSuggestion; confidence: number } | null = null;

  for (const suggestion of suggestions) {
    const confidence = scoreMatch(query, suggestion.title);
    if (best === null || confidence > best.confidence) best = { suggestion, confidence };
  }

  return best;
}
