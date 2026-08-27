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
 * one `appid`, each carrying an `achieved` 0/1 flag and an `unlocktime`. This
 * single call is both the unlocked count AND the total
 * (`achievements.length`) — there is deliberately no second call to
 * `GetSchemaForGame`, since this payload already carries everything both
 * `toAchievementCounts` and `toAchievements` need.
 *
 * `l=english` IS LOAD-BEARING and was verified against the live API: without
 * it Steam returns only `apiname`/`achieved`/`unlocktime` and NO display name
 * or description at all. It was absent while this endpoint was used purely for
 * counting, which never read a name.
 */
export function buildAchievementsUrl(apiKey: string, steamId: string, appid: number): string {
  const params = new URLSearchParams({
    appid: String(appid),
    key: apiKey,
    steamid: steamId,
    l: 'english',
  });
  return `${BASE_URL}/ISteamUserStats/GetPlayerAchievements/v1/?${params.toString()}`;
}

/**
 * `ISteamUser/ResolveVanityURL/v1` — resolves a Steam "vanity URL" name (the
 * `<name>` in `steamcommunity.com/id/<name>`) to a SteamID64. Only needed
 * when `STEAM_ID` isn't already the 17-digit numeric id — see `isSteamId64`
 * below, which decides that.
 *
 * This exists because a Steam profile URL comes in one of two shapes —
 * `/profiles/{steamid64}` or `/id/{vanityname}` — and an owner copying their
 * own profile URL into `STEAM_ID` has no way to know `GetOwnedGames`
 * requires the former. Resolving the latter to the former here is what lets
 * `STEAM_ID` accept whichever the owner actually has.
 */
export function buildResolveVanityUrl(apiKey: string, vanityUrl: string): string {
  const params = new URLSearchParams({ key: apiKey, vanityurl: vanityUrl });
  return `${BASE_URL}/ISteamUser/ResolveVanityURL/v1/?${params.toString()}`;
}

/**
 * A SteamID64 is always exactly 17 digits (Steam's documented format — every
 * real id starts `7656119...`, but the length check alone is enough to tell
 * it apart from a vanity name, which Steam disallows from being all-digit
 * at that length). This is the one place that distinction is decided, so
 * the sync script asks this rather than re-deriving the rule.
 */
const STEAM_ID64_PATTERN = /^\d{17}$/;

export function isSteamId64(value: string): boolean {
  return STEAM_ID64_PATTERN.test(value);
}

export interface ResolvedVanityUrl {
  readonly steamId: string;
}

/**
 * Shapes a `ResolveVanityURL` JSON response. `{"response":{"steamid":"...",
 * "success":1}}` is a match; `success: 42` is Steam's documented code for a
 * vanity name that resolved to no profile at all. Both a non-1 success code
 * and a malformed/missing payload collapse to `null` here — the caller only
 * ever needs "did this resolve, and to what," never Steam's specific error
 * code, so unlike `toAchievementCounts` there is no separate "malformed vs.
 * legitimately not found" distinction to preserve.
 */
export function toResolvedVanityUrl(payload: unknown): ResolvedVanityUrl | null {
  const response = asRecord(asRecord(payload)?.response);
  if (response === null || response.success !== 1) return null;

  const steamId = response.steamid;
  if (typeof steamId !== 'string' || steamId === '') return null;

  return { steamId };
}

export interface OwnedSteamGame {
  readonly appid: number;
  readonly name: string;
  /** Total minutes played, all-time. Convert with `minutesToHoursTenths` (hours.ts) — never inline `/ 6`. */
  readonly playtimeMinutes: number;
  /**
   * ISO 8601, from Steam's `rtime_last_played` — or `null` when Steam reports
   * `0`, which is its "never played" sentinel and NOT a 1970 timestamp. That
   * distinction is load-bearing for the library's recency sort: a real 1970
   * date would rank BELOW every genuine null instead of alongside it.
   *
   * Already present in the response `buildOwnedGamesUrl` fetches (it sets
   * `include_appinfo=1`); this parser simply never read it until the library
   * needed to sort by recency across PSN and Steam together.
   */
  readonly lastPlayedAt: string | null;
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

    // Unix SECONDS, not milliseconds. `> 0` rather than `>= 0` on purpose —
    // see `lastPlayedAt`'s doc comment on Steam's zero sentinel.
    const rawLastPlayed = record.rtime_last_played;
    const lastPlayedAt =
      typeof rawLastPlayed === 'number' && Number.isFinite(rawLastPlayed) && rawLastPlayed > 0
        ? new Date(rawLastPlayed * 1000).toISOString()
        : null;

    return [{ appid, name, playtimeMinutes, lastPlayedAt }];
  });
}

/**
 * `ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2` — what fraction of
 * all players earned each achievement, keyed by `apiname`.
 *
 * A SEPARATE call from `GetPlayerAchievements`, which carries no rarity at all,
 * and the only per-game cost this feature adds to a Steam sync. Takes no API
 * key and no steamid: it is global data about the game, not about the owner.
 */
export function buildGlobalRarityUrl(appid: number): string {
  return `${BASE_URL}/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${appid}`;
}

/** One achievement as Steam describes it, before it becomes a unified `Trophy`. */
export interface SteamAchievement {
  /** Steam's stable per-app key. Joins to the rarity payload, and becomes the trophy row's `external_id`. */
  readonly apiname: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly unlocked: boolean;
  /** Unix SECONDS, or `0` when never unlocked — Steam's sentinel, NOT a 1970 timestamp. */
  readonly unlockTime: number;
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

/**
 * The same payload `toAchievementCounts` reads, kept whole instead of counted.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BOTH MUST BE DERIVED FROM ONE FETCH.
 *
 * `games.achievements_unlocked`/`achievements_total` and the per-achievement
 * rows in `game_trophies` now describe the same fact in two places. That is a
 * real drift risk, and the mitigation is that the sync calls this and
 * `toAchievementCounts` on ONE response — never two requests that could observe
 * different moments. An integration test asserts the two agree after a sync.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `null` (not `[]`) for a game with no achievements, matching
 * `toAchievementCounts` exactly: "this game defines none" and "Steam did not
 * tell us" are different facts, and only one of them should overwrite stored
 * data.
 */
export function toAchievements(payload: unknown): SteamAchievement[] | null {
  const playerstats = asRecord(asRecord(payload)?.playerstats);
  if (playerstats === null || playerstats.success !== true) return null;

  const achievements = playerstats.achievements;
  if (!Array.isArray(achievements) || achievements.length === 0) return null;

  const result: SteamAchievement[] = [];
  for (const entry of achievements) {
    const record = asRecord(entry);
    if (record === null) continue;

    const apiname = record.apiname;
    if (typeof apiname !== 'string' || apiname === '') continue;

    const unlockTime = record.unlocktime;
    result.push({
      apiname,
      // Steam returns an EMPTY STRING for a locked achievement's description,
      // not a missing key — normalized to null so "hidden until unlocked" and
      // "genuinely described as nothing" don't read as the same thing.
      name: typeof record.name === 'string' && record.name !== '' ? record.name : null,
      description: typeof record.description === 'string' && record.description !== '' ? record.description : null,
      unlocked: record.achieved === 1 || record.achieved === true,
      unlockTime: typeof unlockTime === 'number' && Number.isFinite(unlockTime) && unlockTime > 0 ? unlockTime : 0,
    });
  }

  return result;
}

/**
 * `apiname` -> percent-of-players string, from `buildGlobalRarityUrl`.
 *
 * An empty map for any unusable payload, never a throw: rarity is enrichment,
 * and a game whose global stats are unavailable should still get its
 * achievements stored with `rarityTenths: null`.
 */
export function toGlobalRarity(payload: unknown): Map<string, string> {
  const map = new Map<string, string>();
  const achievements = asRecord(asRecord(payload)?.achievementpercentages)?.achievements;
  if (!Array.isArray(achievements)) return map;

  for (const entry of achievements) {
    const record = asRecord(entry);
    if (record === null) continue;
    // Steam names this field `name`, but it holds the API KEY (`CHARMED`),
    // not the display name — the join key, despite the misleading label.
    const apiname = record.name;
    const percent = record.percent;
    if (typeof apiname !== 'string' || apiname === '') continue;
    if (typeof percent === 'number') map.set(apiname, String(percent));
    else if (typeof percent === 'string') map.set(apiname, percent);
  }

  return map;
}

/** The columns the sync script is allowed to touch, as currently stored. */
export interface StoredSteamSyncFields {
  readonly steamAppid: number | null;
  readonly achievementsUnlocked: number | null;
  readonly achievementsTotal: number | null;
  readonly hoursTenths: number | null;
  readonly lastPlayedAt: Date | null;
}

/** Only the columns that should actually be written by default — see `steamSyncFieldsToFill`. */
export interface SteamSyncFill {
  readonly steamAppid?: number;
  readonly achievementsUnlocked?: number;
  readonly achievementsTotal?: number;
  readonly hoursTenths?: number;
  readonly lastPlayedAt?: Date;
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
  lastPlayedAt: string | null = null,
): SteamSyncFill {
  const fill: { -readonly [K in keyof SteamSyncFill]: SteamSyncFill[K] } = {};
  if (current.steamAppid === null && matchedAppid !== null) fill.steamAppid = matchedAppid;
  if (current.achievementsTotal === null && achievements !== null) fill.achievementsTotal = achievements.total;
  if (current.achievementsUnlocked === null && achievements !== null) {
    fill.achievementsUnlocked = achievements.unlocked;
  }
  if (current.hoursTenths === null && hoursTenths !== null) fill.hoursTenths = hoursTenths;
  // Follows the same null-only rule as every other column here, even though
  // `last_played_at` is not a field the owner can type: the SCRIPT's contract
  // is "fill gaps, never overwrite," full stop. The IN-APP sync takes the
  // opposite line and proposes an update whenever Steam disagrees, because
  // Steam is authoritative for objective play data — see `sync-plan.ts`.
  // CLAUDE.md is explicit that these two rules are both correct for their own
  // caller and that unifying them is a bug.
  if (current.lastPlayedAt === null && lastPlayedAt !== null) fill.lastPlayedAt = new Date(lastPlayedAt);
  return fill;
}
