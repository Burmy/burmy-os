/**
 * The ONE place Burmy talks to AniList.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SOFT-FAILURE CONTRACT — LOAD-BEARING, SAME AS IGDB AND STEAM
 *
 *   ANILIST_USERNAME unset            -> null   (checked FIRST; fetch never called)
 *   network error, timeout            -> null
 *   non-2xx, including 429            -> null
 *   GraphQL `errors` in the body      -> null
 *   malformed / unparsable JSON       -> null
 *   request succeeded, empty list     -> []     (a real answer)
 *
 * `null` and `[]` are DIFFERENT and the difference is the point: "the request
 * failed" and "this list is genuinely empty" are separate facts, and
 * collapsing them reports a confident zero when the truth is "we don't know" —
 * the exact reasoning `fetchOwnedGames` in `steam-client.ts` documents.
 *
 * A GraphQL error arrives with HTTP 200 and an `errors` array, so `response.ok`
 * alone is not enough here as it is for the REST clients. That case is checked
 * explicitly below.
 *
 * NO AUTH. The owner's AniList profile is public, so the list and activity
 * feed are readable by username with no token, nothing to expire and nothing
 * to store. If a private profile ever needs supporting, the shape to copy is
 * `psn-client.ts`'s three-way failure string — not a fourth `null`.
 *
 * NOT VERIFIED AGAINST THE LIVE API: the environment this was written in
 * blocks `graphql.anilist.co`. Every failure path below is unit-tested against
 * a stubbed `fetch`; the happy path's field names are not yet confirmed.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  ACTIVITY_QUERY,
  ANILIST_ENDPOINT,
  type AniListActivity,
  type AniListEntry,
  LIST_QUERY,
  hasNextActivityPage,
  toActivities,
  toListEntries,
} from '@/server/anime/anilist';

const TIMEOUT_MS = 10_000;

/** AniList's documented limit is 90 requests/minute. Only the activity walk pages, so only it is throttled. */
const MIN_INTERVAL_MS = 700;

/** Activities per page. AniList caps `perPage` at 50. */
const ACTIVITY_PAGE_SIZE = 50;

/** Refuses to walk forever if `hasNextPage` never goes false — 50 x 200 is far past any real feed. */
const MAX_ACTIVITY_PAGES = 200;

let nextRequestAt = 0;

/**
 * Whether AniList is configured at all.
 *
 * Read DIRECTLY from `process.env`, never inferred from a fetch result — the
 * rule `igdbConfigured()` and `psnConfigured()` both follow, and the reason
 * they exist: `[]` cannot distinguish "not configured" from "empty library",
 * so the UI needs a separate question it can ask.
 */
export function anilistConfigured(): boolean {
  const username = process.env.ANILIST_USERNAME;
  return typeof username === 'string' && username.trim() !== '';
}

function username(): string | null {
  const value = process.env.ANILIST_USERNAME;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

async function pace(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextRequestAt - now);
  nextRequestAt = Math.max(now, nextRequestAt) + MIN_INTERVAL_MS;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

/**
 * One GraphQL POST. Returns the parsed body, or `null` for every failure mode
 * in the contract above.
 *
 * Never throws and never retries. AniList has no token to refresh, so IGDB's
 * one-shot 401 retry has no analogue here; a 429 is a soft failure the caller
 * surfaces as "try again later" rather than something to sit and retry
 * against a shared rate limit.
 */
async function post(query: string, variables: Record<string, unknown>): Promise<unknown> {
  try {
    const response = await fetch(ANILIST_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const body: unknown = await response.json();

    // A GraphQL error comes back as HTTP 200 with an `errors` array — an
    // unknown username lands here, not on the status check above.
    if (typeof body === 'object' && body !== null && Array.isArray((body as { errors?: unknown }).errors)) {
      return null;
    }

    return body;
  } catch {
    // Network error, timeout, or malformed JSON — all mean "no data".
    return null;
  }
}

/**
 * The owner's whole anime list.
 *
 * `MediaListCollection` is unpaginated, so this is one request for the entire
 * library — which is why the sync's snapshot can be taken in a single call at
 * run start and matched against for every chunk afterwards.
 */
export async function fetchAnimeList(): Promise<AniListEntry[] | null> {
  const user = username();
  if (user === null) return null;

  const body = await post(LIST_QUERY, { userName: user });
  if (body === null) return null;

  return toListEntries(body);
}

/**
 * The owner's activity feed, newest first, walked to the end.
 *
 * A page that FAILS ends the walk and returns what was gathered so far rather
 * than `null`: a partial log is genuinely useful and the unique index on
 * `anilist_activity_id` means the next sync fills the gap. That is a different
 * trade from the list above, where a partial library would look like shows had
 * been deleted.
 *
 * `null` only when nothing was reachable at all.
 */
export async function fetchActivities(maxPages = MAX_ACTIVITY_PAGES): Promise<AniListActivity[] | null> {
  const user = username();
  if (user === null) return null;

  const collected: AniListActivity[] = [];

  for (let page = 1; page <= maxPages; page += 1) {
    if (page > 1) await pace();

    const body = await post(ACTIVITY_QUERY, { userName: user, page, perPage: ACTIVITY_PAGE_SIZE });
    if (body === null) return page === 1 ? null : collected;

    collected.push(...toActivities(body));
    if (!hasNextActivityPage(body)) break;
  }

  return collected;
}

/** Test-only: resets the throttle watermark so one test's pacing cannot delay the next. */
export function __resetAnilistThrottleForTests(): void {
  nextRequestAt = 0;
}
