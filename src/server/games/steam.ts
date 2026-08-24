/**
 * Steam Web API — URL building and response shaping for the Steam library
 * sync (`scripts/sync-steam-library.mjs`).
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
 * ─────────────────────────────────────────────────────────────────────────────
 */

// Relative import, not the `@/` alias — matches `stats.ts`'s sibling import
// of `taxonomy.ts`. This is also load-bearing for
// `scripts/sync-steam-library.mjs`, which needs to import this module
// directly via a bare `node` invocation (see that script's header for why);
// a bare `node` invocation resolves an ordinary relative import between two
// alias-free `.ts` files natively, but cannot resolve `@/...` path aliases
// without a bundler or tsconfig-paths loader.
import { normalizeGameTitle, scoreTitleMatch, type TitleMatchScore } from './metadata';

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

export interface SteamTitleMatch {
  readonly game: OwnedSteamGame;
  readonly score: TitleMatchScore;
}

/**
 * Picks the best-scoring Steam-owned game for one stored library title.
 *
 * Reuses `normalizeGameTitle`/`scoreTitleMatch` from `metadata.ts` rather
 * than a second copy of the normalization/confidence policy — HIGH means the
 * normalized titles are identical (directly, or after stripping one trailing
 * parenthetical from either side, e.g. the owner's own "Grand Theft Auto:
 * Vice City (itch)"), exactly the policy `scripts/backfill-game-metadata.mjs`
 * already applies against IGDB. `metadata.ts`'s own `bestTitleMatch` isn't
 * reused directly because it is typed against `GameSuggestion` (IGDB's
 * result shape, with cover art/genre/etc. that a Steam-owned-game entry has
 * no equivalent for) — shoehorning `OwnedSteamGame` into that interface would
 * be more misleading than this small, separately-typed loop over the same
 * underlying `scoreTitleMatch`.
 *
 * Returns `null` for an empty candidate list — "no Steam game to compare
 * against" is a distinct, separately-reported outcome from "compared, but
 * low confidence."
 */
export function bestSteamTitleMatch(storedTitle: string, candidates: readonly OwnedSteamGame[]): SteamTitleMatch | null {
  let best: SteamTitleMatch | null = null;
  for (const game of candidates) {
    const score = scoreTitleMatch(storedTitle, game.name);
    if (best === null || score.distance < best.score.distance) {
      best = { game, score };
    }
  }
  return best;
}

// Re-exported so callers that only need title comparison (the sync script's
// "already matched by steam_appid" fast path still wants normalization for
// logging/reporting) don't need a second import from metadata.ts.
export { normalizeGameTitle };
