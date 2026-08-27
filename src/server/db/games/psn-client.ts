/**
 * The one place a PlayStation Network (PSN) HTTP request happens — including
 * psn-api's NPSSO/OAuth token exchange. Isolated from `src/server/games/psn.ts`
 * so response shaping stays pure and unit-testable, mirroring the
 * `steam.ts` / `steam-client.ts` and `metadata.ts` / `igdb.ts` splits.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE-WAY SOFT-FAILURE CONTRACT — DELIBERATELY NOT THE STEAM CLIENT'S
 * `[]` vs `null` SPLIT
 *
 * `steam-client.ts` returns `[]` for "not configured" and `null` for "the
 * request failed" — that ambiguity caused a real bug (Part 2): the app
 * could not tell "Steam isn't configured" apart from "you own zero games,"
 * and silently created an empty sync run either way. PSN's failure surface
 * is wider than Steam's ever was — the NPSSO expires roughly every two
 * months and the owner has to manually paste a fresh one — so this module
 * returns a discriminated `PsnFailure` value instead of collapsing
 * everything into one falsy shape:
 *
 *   PSN_NPSSO unset                     -> 'not_configured'
 *   NPSSO rejected by Sony's OAuth       -> 'token_expired'
 *   network error, timeout, non-2xx,
 *   malformed response, any other
 *   failure along the way               -> 'unavailable'
 *
 * Each is separately actionable by the UI: "connect PSN," "paste a new
 * NPSSO — yours expired," and "try again later" are three different
 * instructions, not one generic error banner. This module never throws.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ACCOUNT ID — `'me'`, NOT A RESOLVED `getProfileFromUserName` CALL
 *
 * Both `getUserPlayedGames` and `getUserTitles` document `accountId: "me"`
 * as the convention for "the authenticating account" — verified directly in
 * `node_modules/psn-api/dist/index.d.ts` ("Use `\"me\"` for the
 * authenticating account."). There is no separate profile lookup to make or
 * cache; a `getProfileFromUserName` round trip would only add another
 * failure mode for no benefit.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TOKEN LIFECYCLE
 *
 * `PSN_NPSSO` is exchanged for an access/refresh token pair on first use
 * (`exchangeNpssoForAccessCode` -> `exchangeAccessCodeForAuthTokens`) and
 * memoized in module scope for the process lifetime — the same shape
 * `igdb.ts`'s `cachedToken` uses — refreshed with
 * `exchangeRefreshTokenForAuthTokens` once the access token's stated expiry
 * (minus a 60s safety margin) has passed. If a refresh itself fails, this
 * module falls back to one full NPSSO re-exchange before giving up — the
 * failure could be transient rather than session-ending.
 *
 * `exchangeNpssoForAccessCode` throws a specific message ("...Is your NPSSO
 * code valid?...") when Sony's OAuth redirect never carries a `?code=` —
 * verified directly by reading the installed package's source
 * (`node_modules/psn-api/dist/index.mjs`), not assumed from its public
 * types. That message is the ONLY signal this module treats as
 * `'token_expired'`; every other failure at every step — a network error
 * reaching Sony's OAuth endpoint included — is `'unavailable'`.
 *
 * None of psn-api's exported functions accept an `AbortSignal` (verified in
 * the same source read: its internal `fetch` calls take no signal), so this
 * module enforces its own timeout with `withTimeout` rather than relying on
 * one built into the library.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PAGINATION — BOTH ENDPOINTS, HARD-CAPPED
 *
 * `getUserPlayedGames` and `getUserTitles` both page via `nextOffset`.
 * `fetchPlayedTitles` must follow it (the brief for this task calls it out
 * by name); `fetchTrophyTitles` follows the identical `nextOffset` shape on
 * `getUserTitles`'s response for the same reason — stopping after page one
 * would silently under-report the owner's real trophy list exactly the way
 * it would for played titles. Both loops stop at `MAX_PAGES` (20) so a
 * malformed or non-advancing `nextOffset` can never loop forever; the same
 * guard also fires if a response reports a `nextOffset` that doesn't
 * actually advance past the current `offset`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash } from 'node:crypto';

import {
  exchangeAccessCodeForAuthTokens,
  exchangeNpssoForAccessCode,
  exchangeRefreshTokenForAuthTokens,
  getTitleTrophies,
  getUserPlayedGames,
  getUserTitles,
  getUserTrophiesEarnedForTitle,
} from 'psn-api';

import {
  toPlayedTitles,
  toTrophies,
  toTrophyTitles,
  type PsnPlayedTitle,
  type PsnTrophyTitle,
} from '@/server/games/psn';
import type { Trophy } from '@/server/games/trophies';

const TIMEOUT_MS = 5_000;
const MAX_PAGES = 20;
const PAGE_LIMIT = 200;
const REFRESH_MARGIN_MS = 60_000;
const NPSSO_INVALID_MARKER = 'Is your NPSSO code valid?';

export type PsnFailure = 'not_configured' | 'token_expired' | 'unavailable';

export function psnConfigured(): boolean {
  const npsso = process.env.PSN_NPSSO;
  return npsso !== undefined && npsso !== '';
}

/**
 * A SHA-256 fingerprint of the currently configured `PSN_NPSSO`, hex,
 * truncated to 16 characters — never the token itself, and one-way: there
 * is no way to recover the token from this value. Stored on
 * `game_sync_runs.psn_token_fingerprint` (see that column's own doc comment
 * in `schema.ts`) purely so the app can tell "the owner is still using the
 * same PSN token" apart from "a new one was just pasted" without ever
 * persisting or exposing the secret itself. The hash never leaves the
 * database and no Server Action returns it to the client — it exists only
 * to be compared against itself, in SQL, in `getPsnTokenInUseSince`
 * (`src/server/db/games/sync.ts`). `null` when `PSN_NPSSO` is unset,
 * mirroring `psnConfigured()`'s own check.
 */
export function currentPsnTokenFingerprint(): string | null {
  const npsso = process.env.PSN_NPSSO;
  if (npsso === undefined || npsso === '') return null;
  return createHash('sha256').update(npsso).digest('hex').slice(0, 16);
}

interface CachedAuth {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
}

let cachedAuth: CachedAuth | null = null;

/** Test-only: clears the module-scope token cache so each test starts cold. */
export function __resetPsnAuthCacheForTests(): void {
  cachedAuth = null;
}

/**
 * Races any promise against `TIMEOUT_MS`, rejecting with a `TimeoutError`
 * `DOMException` if it wins — the closest equivalent to `AbortSignal.timeout`
 * for a library call that accepts no signal of its own. The original
 * promise's eventual settlement (if it resolves after the timeout) is
 * simply ignored, never awaited further.
 */
function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new DOMException('The operation timed out.', 'TimeoutError'));
    }, TIMEOUT_MS);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function isNpssoInvalidError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(NPSSO_INVALID_MARKER);
}

/**
 * Full NPSSO -> access/refresh token exchange, from a cold start (no cached
 * refresh token to try first). Returns the new `CachedAuth` on success, or
 * the specific `PsnFailure` — `'token_expired'` only for a rejected NPSSO,
 * `'unavailable'` for anything else (a network error reaching Sony's OAuth
 * endpoint, a malformed token response, a missing field).
 */
async function exchangeFreshTokens(npsso: string): Promise<CachedAuth | 'token_expired' | 'unavailable'> {
  let code: string;
  try {
    code = await withTimeout(exchangeNpssoForAccessCode(npsso));
  } catch (error) {
    return isNpssoInvalidError(error) ? 'token_expired' : 'unavailable';
  }
  if (typeof code !== 'string' || code === '') return 'unavailable';

  try {
    const tokens = await withTimeout(exchangeAccessCodeForAuthTokens(code));
    if (typeof tokens.accessToken !== 'string' || tokens.accessToken === '') return 'unavailable';
    if (typeof tokens.refreshToken !== 'string' || tokens.refreshToken === '') return 'unavailable';

    const expiresInMs = typeof tokens.expiresIn === 'number' && Number.isFinite(tokens.expiresIn) ? tokens.expiresIn * 1000 : 0;
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: Date.now() + Math.max(expiresInMs - REFRESH_MARGIN_MS, 0),
    };
  } catch {
    return 'unavailable';
  }
}

/**
 * Attempts to refresh a cached access token via its cached refresh token.
 * Returns the refreshed `CachedAuth` on success, or `null` on any failure —
 * `null` here just means "the caller should fall back to a full NPSSO
 * re-exchange," it is not itself a `PsnFailure`.
 */
async function refreshTokens(auth: CachedAuth): Promise<CachedAuth | null> {
  try {
    const refreshed = await withTimeout(exchangeRefreshTokenForAuthTokens(auth.refreshToken));
    if (typeof refreshed.accessToken !== 'string' || refreshed.accessToken === '') return null;

    const expiresInMs =
      typeof refreshed.expiresIn === 'number' && Number.isFinite(refreshed.expiresIn) ? refreshed.expiresIn * 1000 : 0;
    const refreshToken =
      typeof refreshed.refreshToken === 'string' && refreshed.refreshToken !== '' ? refreshed.refreshToken : auth.refreshToken;

    return {
      accessToken: refreshed.accessToken,
      refreshToken,
      expiresAt: Date.now() + Math.max(expiresInMs - REFRESH_MARGIN_MS, 0),
    };
  } catch {
    return null;
  }
}

type AuthResult = { readonly accessToken: string } | PsnFailure;

/**
 * Resolves a usable access token, handling the full not-configured / cached
 * / expiring-so-refresh / cold-exchange decision tree described in the
 * module header. Returns an object wrapper rather than a bare string so a
 * real (opaque) access token value can never be confused with one of the
 * three `PsnFailure` string literals.
 */
async function getAccessToken(): Promise<AuthResult> {
  const npsso = process.env.PSN_NPSSO;
  if (npsso === undefined || npsso === '') return 'not_configured';

  if (cachedAuth !== null && cachedAuth.expiresAt > Date.now()) {
    return { accessToken: cachedAuth.accessToken };
  }

  if (cachedAuth !== null) {
    const refreshed = await refreshTokens(cachedAuth);
    if (refreshed !== null) {
      cachedAuth = refreshed;
      return { accessToken: refreshed.accessToken };
    }
    // Refresh failed — fall through to a full re-exchange below.
  }

  const result = await exchangeFreshTokens(npsso);
  if (result === 'token_expired' || result === 'unavailable') {
    cachedAuth = null;
    return result;
  }

  cachedAuth = result;
  return { accessToken: result.accessToken };
}

function isFailure(value: unknown): value is PsnFailure {
  return value === 'not_configured' || value === 'token_expired' || value === 'unavailable';
}

/**
 * The owner's full PSN played-games library, across all pages. See the
 * module header for the failure contract and the pagination guard.
 */
export async function fetchPlayedTitles(): Promise<PsnPlayedTitle[] | PsnFailure> {
  const auth = await getAccessToken();
  if (isFailure(auth)) return auth;

  const collected: PsnPlayedTitle[] = [];
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    let response: unknown;
    try {
      response = await withTimeout(
        getUserPlayedGames({ accessToken: auth.accessToken }, 'me', { limit: PAGE_LIMIT, offset }),
      );
    } catch {
      return 'unavailable';
    }

    collected.push(...toPlayedTitles(response));

    const next = (response as { nextOffset?: unknown } | null)?.nextOffset;
    if (typeof next !== 'number' || !Number.isFinite(next) || next <= offset) break;
    offset = next;
  }

  return collected;
}

/**
 * The owner's full PSN trophy title list, across all pages. Same failure
 * contract and pagination guard as `fetchPlayedTitles`.
 */
export async function fetchTrophyTitles(): Promise<PsnTrophyTitle[] | PsnFailure> {
  const auth = await getAccessToken();
  if (isFailure(auth)) return auth;

  const collected: PsnTrophyTitle[] = [];
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    let response: unknown;
    try {
      response = await withTimeout(getUserTitles({ accessToken: auth.accessToken }, 'me', { limit: PAGE_LIMIT, offset }));
    } catch {
      return 'unavailable';
    }

    collected.push(...toTrophyTitles(response));

    const next = (response as { nextOffset?: unknown } | null)?.nextOffset;
    if (typeof next !== 'number' || !Number.isFinite(next) || next <= offset) break;
    offset = next;
  }

  return collected;
}

/**
 * Same `nextOffset`-driven pagination loop `fetchPlayedTitles`/
 * `fetchTrophyTitles` each already inline once — factored out here because
 * `fetchGameTrophies` below needs it TWICE, for two independent endpoints.
 * Returns the raw, un-shaped `trophies` entries from every page collected
 * into one array, or `'unavailable'` the moment any page's request fails —
 * a partial trophy list would misreport a game as less complete/rarer than
 * it really is, which is worse than one clear failure state.
 */
async function collectTrophyPages(fetchPage: (offset: number) => Promise<unknown>): Promise<unknown[] | 'unavailable'> {
  const collected: unknown[] = [];
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    let response: unknown;
    try {
      response = await withTimeout(fetchPage(offset));
    } catch {
      return 'unavailable';
    }

    const trophies = (response as { trophies?: unknown } | null)?.trophies;
    if (Array.isArray(trophies)) collected.push(...trophies);

    const next = (response as { nextOffset?: unknown } | null)?.nextOffset;
    if (typeof next !== 'number' || !Number.isFinite(next) || next <= offset) break;
    offset = next;
  }

  return collected;
}

/**
 * One game's full trophy detail, fetched LIVE every call — no caching
 * table, mirroring `igdb.ts`'s `fetchUpcomingGames()`. Neither
 * `getTitleTrophies` (the catalog: name/description/icon/tier) nor
 * `getUserTrophiesEarnedForTitle` (earned state/date/rarity) is used
 * anywhere else in this codebase; `psn.ts`'s `toTrophies` explains why the
 * two must be joined client-side. Run via `Promise.all` — the two endpoints
 * are independent, so a page waits one round-trip-worth of latency, not
 * two. `trophyGroupId: 'all'` returns every group (base game + DLC) in one
 * pair of calls; see `Trophy.groupId`'s own doc comment for what happens to
 * that value downstream.
 */
export async function fetchGameTrophies(
  npCommunicationId: string,
  npServiceName: 'trophy' | 'trophy2',
): Promise<Trophy[] | PsnFailure> {
  const auth = await getAccessToken();
  if (isFailure(auth)) return auth;

  const [titlePages, userPages] = await Promise.all([
    collectTrophyPages((offset) =>
      getTitleTrophies({ accessToken: auth.accessToken }, npCommunicationId, 'all', {
        npServiceName,
        limit: PAGE_LIMIT,
        offset,
      }),
    ),
    collectTrophyPages((offset) =>
      getUserTrophiesEarnedForTitle({ accessToken: auth.accessToken }, 'me', npCommunicationId, 'all', {
        npServiceName,
        limit: PAGE_LIMIT,
        offset,
      }),
    ),
  ]);

  if (titlePages === 'unavailable' || userPages === 'unavailable') return 'unavailable';

  return toTrophies({ trophies: titlePages }, { trophies: userPages });
}
