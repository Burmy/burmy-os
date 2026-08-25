/**
 * The one place a game-metadata HTTP request happens.
 *
 * Isolated from `src/server/games/metadata.ts` so all the URL/query building
 * and response shaping stays pure and unit-testable. Failure is ALWAYS soft:
 * cover art and its accompanying metadata are a nicety, and an IGDB or Twitch
 * outage must never block adding a game to the library.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AUTH
 *
 * IGDB authenticates via Twitch's client-credentials OAuth flow. The access
 * token is long-lived (~64 days per Twitch's own documented response), so it
 * is cached in module scope rather than fetched per request — but a cached
 * token can be invalidated server-side before its stated expiry (e.g. the
 * Twitch app's secret was rotated), so a 401 from IGDB itself always clears
 * the cache and retries the failed request exactly once with a fresh token,
 * never in a loop.
 *
 * A serverless/Netlify deployment may not keep this module warm between
 * invocations. The simplest correct version doesn't need persistence beyond
 * that: worst case, a cold invocation pays one extra token POST before the
 * real query, which is an acceptable cost for a human-paced, keystroke- or
 * button-triggered search flow — not a hot request path.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  buildSearchQuery,
  buildTimeToBeatQuery,
  buildUpcomingQuery,
  toSuggestions,
  withPlaytime,
  type GameSuggestion,
} from '@/server/games/metadata';
import { toUpcomingGames, type UpcomingGame } from '@/server/games/upcoming';

const TIMEOUT_MS = 5_000;
const SEARCH_LIMIT = 6;
const TOKEN_ENDPOINT = 'https://id.twitch.tv/oauth2/token';
const GAMES_ENDPOINT = 'https://api.igdb.com/v4/games';
const TIME_TO_BEAT_ENDPOINT = 'https://api.igdb.com/v4/game_time_to_beats';

/**
 * Minimum `hypes` (pre-release follows) for a game to appear in "Upcoming
 * games". IGDB publishes no documented scale for `hypes` — there is no
 * "AAA = 500, indie = 20" anywhere in their schema — so this was calibrated
 * against real, live data rather than guessed.
 *
 * Counts measured live over the next 12 months, PS5+PC, `game_type = 0`
 * (main games only), at several candidate floors:
 *
 *   floor  count   notes
 *   10     120     the firehose the owner explicitly rejected
 *   20      66     tail still admits obscure titles ("Decrepit", "Woodo")
 *   30      45     tail still holds real franchise entries ("Warhammer
 *                  40,000: Dawn of War IV") — CHOSEN
 *   50      27     thins to ~2/month; risks empty months
 *
 * 30 is the floor where the list stops reading like an indie-storefront feed
 * and starts reading like games the owner would actually buy, without
 * thinning out so far that some months come up empty.
 */
const HYPE_FLOOR = 30;

/** "Next 12 months" — the window this tab looks ahead, per the design decision. */
const UPCOMING_WINDOW_MONTHS = 12;

interface Credentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

let cachedToken: CachedToken | null = null;

/** Test-only: clears the module-scope token cache so each test starts cold. */
export function __resetIgdbTokenCacheForTests(): void {
  cachedToken = null;
}

function credentials(): Credentials | null {
  const clientId = process.env.IGDB_CLIENT_ID;
  const clientSecret = process.env.IGDB_CLIENT_SECRET;
  // Not configured is a normal state, not an error: the app is fully usable
  // without cover art, and the test suite must pass with neither var present.
  if (clientId === undefined || clientId === '' || clientSecret === undefined || clientSecret === '') return null;
  return { clientId, clientSecret };
}

async function fetchToken({ clientId, clientSecret }: Credentials): Promise<CachedToken | null> {
  try {
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    });
    const response = await fetch(`${TOKEN_ENDPOINT}?${params.toString()}`, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return null;
    const record = body as Record<string, unknown>;
    if (typeof record.access_token !== 'string' || record.access_token === '') return null;
    if (typeof record.expires_in !== 'number') return null;

    // 60s safety margin so a token already near its stated expiry is never
    // handed out and immediately rejected.
    return { token: record.access_token, expiresAt: Date.now() + (record.expires_in - 60) * 1000 };
  } catch {
    // Network error, timeout, or malformed JSON — all mean "no token".
    return null;
  }
}

async function getToken(creds: Credentials): Promise<string | null> {
  if (cachedToken !== null && cachedToken.expiresAt > Date.now()) return cachedToken.token;
  cachedToken = await fetchToken(creds);
  return cachedToken?.token ?? null;
}

function requestInit(token: string, clientId: string, body: string): RequestInit {
  return {
    method: 'POST',
    headers: { 'Client-ID': clientId, Authorization: `Bearer ${token}`, Accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
}

/**
 * POSTs an Apicalypse body to an IGDB endpoint. Retries exactly once, with a
 * freshly fetched token, if the first attempt comes back 401 — never a loop.
 * Returns `null` (never throws) on missing credentials, a network error, a
 * non-2xx response, or no token being obtainable at all; the caller decides
 * how to treat `null` in its own soft-failure path.
 */
async function igdbPost(endpoint: string, body: string, creds: Credentials): Promise<unknown> {
  const token = await getToken(creds);
  if (token === null) return null;

  let response = await fetch(endpoint, requestInit(token, creds.clientId, body));

  if (response.status === 401) {
    cachedToken = null;
    const freshToken = await getToken(creds);
    if (freshToken === null) return null;
    response = await fetch(endpoint, requestInit(freshToken, creds.clientId, body));
  }

  if (!response.ok) return null;
  return response.json();
}

export async function searchGames(query: string): Promise<GameSuggestion[]> {
  const creds = credentials();
  if (creds === null) return [];
  if (query.trim() === '') return [];

  let suggestions: GameSuggestion[];
  try {
    const payload = await igdbPost(GAMES_ENDPOINT, buildSearchQuery(query, SEARCH_LIMIT), creds);
    if (payload === null) return [];
    suggestions = toSuggestions(payload);
  } catch {
    // Network error, timeout, or malformed JSON on the primary search — the
    // one call the add/edit form actually blocks on — degrades to [].
    return [];
  }
  if (suggestions.length === 0) return suggestions;

  const gameIds = suggestions
    .map((suggestion) => Number(suggestion.externalId))
    .filter((id) => Number.isFinite(id));
  if (gameIds.length === 0) return suggestions;

  try {
    const timeToBeatPayload = await igdbPost(TIME_TO_BEAT_ENDPOINT, buildTimeToBeatQuery(gameIds), creds);
    return timeToBeatPayload === null ? suggestions : withPlaytime(suggestions, timeToBeatPayload);
  } catch {
    // Time-to-beat is a bonus enrichment on an already-successful search;
    // its failure must never blank out real results the owner is about to
    // pick from — it only leaves averagePlaytimeHours null.
    return suggestions;
  }
}

/**
 * Fetches the "Upcoming games" candidate list — one live request per page
 * load (see `buildUpcomingQuery` in `metadata.ts` for the query and the
 * calibration/hazard notes it documents). Fetched fresh on every visit, no
 * cached table, per the design decision.
 *
 * Soft-fails to `[]` on missing credentials, a network error, a timeout, a
 * non-2xx response, or malformed JSON — never a throw, exactly like
 * `searchGames` above. The tab's empty state is this function returning
 * `[]`, not an error path the caller has to special-case.
 */
export async function fetchUpcomingGames(): Promise<UpcomingGame[]> {
  const creds = credentials();
  if (creds === null) return [];

  try {
    const now = new Date();
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const horizon = new Date(now);
    horizon.setUTCMonth(horizon.getUTCMonth() + UPCOMING_WINDOW_MONTHS);
    const horizonSeconds = Math.floor(horizon.getTime() / 1000);

    const payload = await igdbPost(GAMES_ENDPOINT, buildUpcomingQuery(nowSeconds, horizonSeconds, HYPE_FLOOR), creds);
    return payload === null ? [] : toUpcomingGames(payload);
  } catch {
    // Network error, timeout, or malformed JSON — degrades to an empty tab.
    return [];
  }
}
