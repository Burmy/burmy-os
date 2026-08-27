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
 * not an error: this module started as the one thing
 * `scripts/sync-steam-library.mjs` called, but the in-app sync
 * (`src/features/games/sync/`, 2026-08-24) now calls it from a real request
 * path too — `startSteamSyncAction`/`advanceSteamSyncAction` in
 * `sync-actions.ts`. It still follows the exact same soft-fail contract
 * either way, because the full test suite must pass with neither var
 * present, and because "fail soft, report clearly" is simply the right
 * shape for any third-party integration in this codebase.
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
  buildResolveVanityUrl,
  isSteamId64,
  toAchievementCounts,
  buildGlobalRarityUrl,
  toAchievements,
  toGlobalRarity,
  toOwnedGames,
  toResolvedVanityUrl,
  type AchievementCounts,
  type OwnedSteamGame,
  type SteamAchievement,
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
 * Memoized per raw `STEAM_ID` value, for the life of this module instance.
 * `resolveSteamId` below runs before EVERY `GetOwnedGames`/
 * `GetPlayerAchievements` call — a single sync run calls it once per
 * matched game for achievements alone — and the resolution can't change
 * mid-process (`process.env.STEAM_ID` is static), so re-resolving on every
 * call would just be extra Steam API traffic for the same answer.
 */
let vanityResolutionCache: { readonly rawSteamId: string; readonly resolved: string | null } | null = null;

/**
 * Resolves `rawSteamId` to a numeric SteamID64, the only form
 * `GetOwnedGames`/`GetPlayerAchievements` accept — `STEAM_ID` itself may be
 * a vanity name (`steamcommunity.com/id/<name>`), same acceptance rule
 * `scripts/sync-steam-library.mjs`'s own `resolveSteamId` documents. A
 * 17-digit value (`isSteamId64`) is returned as-is, no request made.
 *
 * Soft-fails to `null` on any resolution problem — a failed request, a
 * non-2xx, malformed JSON, or Steam's `success: 42` for a name that matches
 * no profile (`toResolvedVanityUrl`) — matching this module's contract
 * (never throw) rather than the CLI script's throw-on-failure. `null` here
 * is indistinguishable from any other failed-request `null` to this
 * module's own callers, which is correct: from `fetchOwnedGames`'s
 * perspective, "couldn't resolve the id" and "the games request itself
 * failed" are the same fact — the request never had a real id to succeed
 * with.
 */
async function resolveSteamId(rawSteamId: string, apiKey: string): Promise<string | null> {
  if (isSteamId64(rawSteamId)) return rawSteamId;

  if (vanityResolutionCache !== null && vanityResolutionCache.rawSteamId === rawSteamId) {
    return vanityResolutionCache.resolved;
  }

  const payload = await getJson(buildResolveVanityUrl(apiKey, rawSteamId));
  const resolved = payload === null ? null : (toResolvedVanityUrl(payload)?.steamId ?? null);
  vanityResolutionCache = { rawSteamId, resolved };
  return resolved;
}

/**
 * The owner's full Steam library. Returns `[]` on missing credentials
 * (a normal, unconfigured state — no request was even attempted) or on a
 * successful response that genuinely carries zero games (a private "Game
 * details" profile, or an account that really owns nothing — Steam's own
 * response shape doesn't distinguish those two, see `toOwnedGames`).
 * Returns `null` when the REQUEST ITSELF failed — network error, timeout,
 * non-2xx, malformed JSON, or a vanity `STEAM_ID` that couldn't be
 * resolved — so a caller that needs to tell "no data because the request
 * failed" apart from "no data because there are zero games" can. See the
 * module header.
 */
export async function fetchOwnedGames(): Promise<OwnedSteamGame[] | null> {
  const creds = credentials();
  if (creds === null) return [];

  const steamId = await resolveSteamId(creds.steamId, creds.apiKey);
  if (steamId === null) return null;

  const payload = await getJson(buildOwnedGamesUrl(creds.apiKey, steamId));
  return payload === null ? null : toOwnedGames(payload);
}

/**
 * Unlocked/total achievement counts for one Steam `appid`. Returns `null` on
 * missing credentials, an unresolvable vanity `STEAM_ID`, any request
 * failure, or a game with no achievements at all (Steam's own error-shaped
 * response for that case — see `toAchievementCounts`).
 */
export async function fetchAchievementCounts(appid: number): Promise<AchievementCounts | null> {
  const creds = credentials();
  if (creds === null) return null;

  const steamId = await resolveSteamId(creds.steamId, creds.apiKey);
  if (steamId === null) return null;

  const payload = await getJson(buildAchievementsUrl(creds.apiKey, steamId, appid));
  return payload === null ? null : toAchievementCounts(payload);
}

/**
 * One game's achievements in full — detail AND counts — from a SINGLE
 * `GetPlayerAchievements` response, plus global rarity from a second call.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS RETURNS BOTH, RATHER THAN THE CALLER MAKING TWO CALLS.
 *
 * `games.achievements_unlocked`/`achievements_total` and the per-achievement
 * rows in `game_trophies` describe the same fact twice. Deriving them from one
 * response makes disagreement impossible; two separate `fetch`es could observe
 * different moments and silently drift. That is the whole reason this exists
 * instead of the caller composing `fetchAchievementCounts` with a detail call.
 *
 * The rarity request is separate because Steam genuinely serves it from a
 * different endpoint (it is global data about the game, not about the owner).
 * It fails SOFT and independently: a game with no global stats still gets its
 * achievements stored, with `rarityTenths: null` throughout.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export async function fetchAchievementDetail(
  appid: number,
): Promise<{ readonly achievements: SteamAchievement[]; readonly counts: AchievementCounts; readonly rarity: Map<string, string> } | null> {
  const creds = credentials();
  if (creds === null) return null;

  const steamId = await resolveSteamId(creds.steamId, creds.apiKey);
  if (steamId === null) return null;

  const payload = await getJson(buildAchievementsUrl(creds.apiKey, steamId, appid));
  if (payload === null) return null;

  const achievements = toAchievements(payload);
  const counts = toAchievementCounts(payload);
  if (achievements === null || counts === null) return null;

  const rarityPayload = await getJson(buildGlobalRarityUrl(appid));
  return { achievements, counts, rarity: toGlobalRarity(rarityPayload) };
}
