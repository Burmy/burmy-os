/**
 * The one place a Steam Web API request happens.
 *
 * Isolated from `src/server/games/steam.ts` so all the URL building and
 * response shaping stays pure and unit-testable — the same split
 * `src/server/db/games/igdb.ts` / `src/server/games/metadata.ts` already
 * establishes for IGDB.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SOFT-FAILURE CONTRACT — LOAD-BEARING, SAME AS IGDB
 *
 * `STEAM_API_KEY`/`STEAM_ID` are OPTIONAL. Their absence is a normal state,
 * not an error: this module is only ever called from
 * `scripts/sync-steam-library.mjs`, a manually-run one-off tool, never from
 * a request path the owner depends on to use the app — but it still follows
 * the exact same contract as `igdb.ts` because the full test suite must pass
 * with neither var present, and because "fail soft, report clearly" is
 * simply the right shape for any third-party integration in this codebase.
 *
 *   missing STEAM_API_KEY or STEAM_ID -> [] / null (checked first)
 *   network error, timeout            -> null / null
 *   non-2xx response                  -> null / null
 *   malformed / unparsable JSON       -> null / null
 *   request succeeded, 0 games/no data -> [] / null
 *
 * Never throws — but `fetchOwnedGames` is NOT a flat "always []" contract:
 * the request itself failing (network error, timeout, non-2xx, malformed
 * JSON) returns `null`, distinct from a SUCCESSFUL response that genuinely
 * carries zero games (a private "Game details" profile, or an account that
 * really owns nothing — Steam's response shape doesn't distinguish those
 * two, see `toOwnedGames`). That distinction matters to a caller whose job
 * is reporting a diff: "the request failed" and "this account owns zero
 * games" are different facts, and collapsing them into the same `[]` reads
 * as a confident, wrong report of "0 games" when the true story is "we
 * don't know." `fetchAchievementCounts` has no such split — every one of
 * its failure modes, including a real game with zero defined achievements,
 * already collapses to `null` by design (see `toAchievementCounts`), and
 * the sync script never needed to tell those apart.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  buildAchievementsUrl,
  buildOwnedGamesUrl,
  toAchievementCounts,
  toOwnedGames,
  type AchievementCounts,
  type OwnedSteamGame,
} from '@/server/games/steam';

const TIMEOUT_MS = 5_000;

interface Credentials {
  readonly apiKey: string;
  readonly steamId: string;
}

function credentials(): Credentials | null {
  const apiKey = process.env.STEAM_API_KEY;
  const steamId = process.env.STEAM_ID;
  // Not configured is a normal state, not an error — see the header comment.
  if (apiKey === undefined || apiKey === '' || steamId === undefined || steamId === '') return null;
  return { apiKey, steamId };
}

async function getJson(url: string): Promise<unknown> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    // Network error, timeout, or malformed JSON — all mean "no data".
    return null;
  }
}

/**
 * The owner's full Steam library. Returns `[]` on missing credentials
 * (a normal, unconfigured state — no request was even attempted) or on a
 * successful response that genuinely carries zero games (a private "Game
 * details" profile, or an account that really owns nothing — Steam's own
 * response shape doesn't distinguish those two, see `toOwnedGames`).
 * Returns `null` when the REQUEST ITSELF failed — network error, timeout,
 * non-2xx, or malformed JSON — so a caller that needs to tell "no data
 * because the request failed" apart from "no data because there are zero
 * games" can. See the module header.
 */
export async function fetchOwnedGames(): Promise<OwnedSteamGame[] | null> {
  const creds = credentials();
  if (creds === null) return [];

  const payload = await getJson(buildOwnedGamesUrl(creds.apiKey, creds.steamId));
  return payload === null ? null : toOwnedGames(payload);
}

/**
 * Unlocked/total achievement counts for one Steam `appid`. Returns `null` on
 * missing credentials, any request failure, or a game with no achievements
 * at all (Steam's own error-shaped response for that case — see
 * `toAchievementCounts`).
 */
export async function fetchAchievementCounts(appid: number): Promise<AchievementCounts | null> {
  const creds = credentials();
  if (creds === null) return null;

  const payload = await getJson(buildAchievementsUrl(creds.apiKey, creds.steamId, appid));
  return payload === null ? null : toAchievementCounts(payload);
}
