/**
 * Steam Web API — URL building, response shaping, and the fill-decision
 * policy for the Steam library sync (`scripts/sync-steam-library.mjs`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY STEAM, NOT PSN, GOT BUILT FIRST
 *
 * See `.superpowers/sdd/2026-08-20-game-tracker/psn-integration-research.md`
 * for the full comparison. In short: Steam's Web API is official, documented,
 * and stable (an API key that never expires, a real published contract),
 * where PSN would mean either scraping a scraper (PSNProfiles, actively
 * resisted by Cloudflare) or driving `psn-api` against Sony's own
 * undocumented endpoints with a ~60-day manual NPSSO re-auth chore forever.
 * Steam is the unambiguous easy win; PSN stays a research note, not code.
 *
 * This module is PURE — it builds request URLs and shapes JSON responses but
 * never performs a request. The one `fetch` lives in
 * `src/server/db/games/steam-client.ts`, mirroring the IGDB split
 * (`src/server/games/metadata.ts` / `src/server/db/games/igdb.ts`) so this
 * logic stays testable without a network or a fake server.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DELIBERATELY A LEAF MODULE — NO IMPORTS OF ITS OWN
 *
 * `scripts/sync-steam-library.mjs` needs to `node`-import this file
 * directly, the same way `scripts/backfill-game-metadata.mjs` already
 * `node`-imports `metadata.ts` — see that script's header for the full
 * reasoning. The short version: Node's native TypeScript support resolves a
 * plain `node script.ts` entrypoint fine, but its ESM resolver still
 * requires an explicit, resolvable specifier for every relative import in
 * the chain (verified directly: an extensionless `./metadata` import fails
 * with `ERR_MODULE_NOT_FOUND` under a bare `node` invocation, where the same
 * import resolves fine under Next's bundler or `tsc`). The only import this
 * module would otherwise want — `metadata.ts`'s title-matching helpers — is
 * why `bestTitleMatchAmong` was added to `metadata.ts` itself instead of
 * imported from here: that keeps BOTH files leaf modules, and the sync
 * script imports each of them directly for what it needs.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const BASE_URL = 'https://api.steampowered.com';

/**
 * `IPlayerService/GetOwnedGames/v1` — the owner's full Steam library in one
 * call. `include_appinfo=1` is what makes the response carry each game's
 * `name` (without it, only `appid`/`playtime_forever` come back, useless for
 * title matching); `include_played_free_games=1` includes free-to-play
 * titles the account owns, which would otherwise be silently excluded from
 * `game_count`/`games` even though they show up in the owner's real library.
 *
 * Returns an EMPTY list, not an error, if the account's "Game details"
 * privacy is not Public — Steam does not distinguish "wrong key" from
 * "private profile" in the response shape, both simply omit `games`. See
 * `toOwnedGames` below.
 */
export function buildOwnedGamesUrl(apiKey: string, steamId: string): string {
  const params = new URLSearchParams({
    key: apiKey,
    steamid: steamId,
    format: 'json',
    include_appinfo: '1',
    include_played_free_games: '1',
  });
  return `${BASE_URL}/IPlayerService/GetOwnedGames/v1/?${params.toString()}`;
}

/**
 * `ISteamUserStats/GetPlayerAchievements/v1` — every achievement defined for
 * one `appid`, each carrying an `achieved` 0/1 flag. This single call is
 * both the unlocked count AND the total (`achievements.length`) — there is
 * deliberately no second call to `GetSchemaForGame` here, since this payload
 * already carries everything `toAchievementCounts` needs.
 */
export function buildAchievementsUrl(apiKey: string, steamId: string, appid: number): string {
  const params = new URLSearchParams({
    appid: String(appid),
    key: apiKey,
    steamid: steamId,
  });
  return `${BASE_URL}/ISteamUserStats/GetPlayerAchievements/v1/?${params.toString()}`;
}

export interface OwnedSteamGame {
  readonly appid: number;
  readonly name: string;
  /** Total minutes played, all-time. Convert with `minutesToHoursTenths` (hours.ts) — never inline `/ 6`. */
  readonly playtimeMinutes: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Shapes a `GetOwnedGames` JSON response into `OwnedSteamGame[]`. Defensive
 * by construction — a third-party payload is untrusted shape, not a typed
 * contract, exactly like `metadata.ts`'s `toSuggestions`: a malformed entry
 * is skipped, never thrown on.
 *
 * A private profile (or a profile with "Game details" not set to Public)
 * returns `{ "response": {} }` — no `games` key at all, not an error and not
 * an empty array under a present key. That collapses to `[]` here the same
 * as a genuinely empty library; the caller/report is what tells the owner
 * "zero games returned" is worth checking their Steam privacy setting.
 */
export function toOwnedGames(payload: unknown): OwnedSteamGame[] {
  const response = asRecord(asRecord(payload)?.response);
  const games = response?.games;
  if (!Array.isArray(games)) return [];

  return games.flatMap((entry): OwnedSteamGame[] => {
    const record = asRecord(entry);
    if (record === null) return [];

    const appid = record.appid;
    const name = record.name;
    if (typeof appid !== 'number' || !Number.isInteger(appid) || typeof name !== 'string' || name === '') {
      return [];
    }

    const rawPlaytime = record.playtime_forever;
    const playtimeMinutes =
      typeof rawPlaytime === 'number' && Number.isFinite(rawPlaytime) && rawPlaytime >= 0 ? rawPlaytime : 0;

    return [{ appid, name, playtimeMinutes }];
  });
}

export interface AchievementCounts {
  readonly unlocked: number;
  readonly total: number;
}

/**
 * Shapes a `GetPlayerAchievements` JSON response into `{ unlocked, total }`.
 *
 * A game with no achievements at all — including every one of the 40 PSP
 * titles' Steam-side non-equivalents, and any Steam game that simply never
 * defined achievements — returns an ERROR-shaped body from this endpoint
 * (`{ "playerstats": { "success": false, "error": "Requested app has no
 * stats" } }`), not an empty achievements array under `success: true`. That
 * is treated as `null` here, matching "no achievement data available" —
 * never coerced to `{ unlocked: 0, total: 0 }`, which would read as "this
 * game defines zero achievements and the owner earned zero" and is a real,
 * different fact this response never actually asserts.
 *
 * `achieved` arrives as a `1`/`0` integer per Steam's documented shape; `true`
 * is also accepted defensively in case a future response ever sends a real
 * boolean instead.
 */
export function toAchievementCounts(payload: unknown): AchievementCounts | null {
  const playerstats = asRecord(asRecord(payload)?.playerstats);
  if (playerstats === null || playerstats.success !== true) return null;

  const achievements = playerstats.achievements;
  if (!Array.isArray(achievements) || achievements.length === 0) return null;

  // `total` is the array length itself, including any malformed entry — it
  // still occupies one slot in Steam's defined-achievements list, even if
  // this payload's shape for that one entry is too broken to say whether it
  // was achieved. Only `unlocked` skips a malformed entry, since "achieved"
  // is genuinely unknown for it.
  let unlocked = 0;
  for (const entry of achievements) {
    const record = asRecord(entry);
    if (record !== null && (record.achieved === 1 || record.achieved === true)) unlocked += 1;
  }

  return { unlocked, total: achievements.length };
}

/** The four columns the sync script is allowed to touch, as currently stored. */
export interface StoredSteamSyncFields {
  readonly steamAppid: number | null;
  readonly achievementsUnlocked: number | null;
  readonly achievementsTotal: number | null;
  readonly hoursTenths: number | null;
}

/** Only the columns that should actually be written by default — see `steamSyncFieldsToFill`. */
export interface SteamSyncFill {
  readonly steamAppid?: number;
  readonly achievementsUnlocked?: number;
  readonly achievementsTotal?: number;
  readonly hoursTenths?: number;
}

/**
 * Which of the four syncable columns should be filled for one game, given a
 * resolved Steam appid (existing or freshly HIGH-confidence matched — the
 * caller decides that, not this function) and what Steam returned for
 * achievements/playtime: only a column that is CURRENTLY NULL, and only when
 * the corresponding Steam-sourced value is available.
 *
 * This is the code-level enforcement of "fill by default only where the
 * stored value is NULL" — the same role `metadata.ts`'s own
 * `metadataFieldsToFill` plays for the IGDB backfill, so the sync script
 * never has to remember the null-only rule at every call site.
 *
 * A column where the CURRENT value is non-null and DIFFERS from Steam's is
 * deliberately left OUT of this function's result — that is a difference to
 * report, never a silent overwrite. Overwriting `hoursTenths` specifically
 * (Steam's measured playtime is more accurate than a hand-typed estimate,
 * but silently rewriting the owner's own record is the exact failure this
 * whole feature is built to avoid) is a decision the SCRIPT makes
 * explicitly, gated behind `--overwrite-hours`, never something this
 * function does on its own. There is no equivalent overwrite path for
 * `achievementsUnlocked`/`achievementsTotal` at all — a differing
 * achievement count is reported and left alone, full stop.
 *
 * Built with `if` statements into a mutable local object, not conditional
 * spreads, for the same `exactOptionalPropertyTypes` reason
 * `metadataFieldsToFill` documents (CLAUDE.md's gotcha on M7's review
 * filters): more than two or three independently-optional fields assembled
 * in one object literal loses precision under the merged-spread form.
 */
export function steamSyncFieldsToFill(
  current: StoredSteamSyncFields,
  matchedAppid: number | null,
  achievements: AchievementCounts | null,
  hoursTenths: number | null,
): SteamSyncFill {
  const fill: { -readonly [K in keyof SteamSyncFill]: SteamSyncFill[K] } = {};
  if (current.steamAppid === null && matchedAppid !== null) fill.steamAppid = matchedAppid;
  if (current.achievementsTotal === null && achievements !== null) fill.achievementsTotal = achievements.total;
  if (current.achievementsUnlocked === null && achievements !== null) {
    fill.achievementsUnlocked = achievements.unlocked;
  }
  if (current.hoursTenths === null && hoursTenths !== null) fill.hoursTenths = hoursTenths;
  return fill;
}
