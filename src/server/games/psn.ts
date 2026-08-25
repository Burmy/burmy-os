/**
 * PlayStation Network — pure duration/category conversion and response
 * shaping for the PSN library sync.
 *
 * Mirrors the `steam.ts` / `steam-client.ts` split (itself mirroring
 * `metadata.ts` / `igdb.ts`): this module builds nothing and requests
 * nothing — it only converts PSN's untyped, third-party JSON shapes into
 * this app's own types. The one HTTP boundary, including psn-api's NPSSO/
 * OAuth exchange, lives in `src/server/db/games/psn-client.ts`.
 *
 * PURE LEAF RULE: no React, no Next, no HTTP, no database. May import from
 * other `src/server/games/` modules, but does not need to here — see
 * `parsePlayDuration` below for why the tenths-of-an-hour conversion is done
 * locally rather than reusing `hours.ts`'s `minutesToHoursTenths`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO FACTS VERIFIED DIRECTLY AGAINST THE INSTALLED PACKAGE
 * (`node_modules/psn-api/dist/index.d.ts`), NOT ASSUMED
 *
 * 1. `TrophyCounts` (referenced by `TrophyTitle.definedTrophies`/
 *    `earnedTrophies`) is `{ bronze: number; silver: number; gold: number;
 *    platinum: 0 | 1 }` — `platinum` is a 0/1 flag, not a count, because a
 *    title can only ever have one platinum trophy. `toTrophyTitles` below
 *    sums all four fields for `earned`/`total` (platinum contributing 0 or 1)
 *    and reports `platinum: true` only when `earnedTrophies.platinum === 1`.
 *
 * 2. `pspc_game`'s meaning was NOT confirmed. It appears only as one
 *    `@example` value on `UserPlayedGamesResponse`'s `category` field (a
 *    plain `string`, not a documented enum) alongside `ps4_game`,
 *    `ps5_native_game`, and `unknown` — no comment, README section, or
 *    runtime code anywhere in the installed package says what it stands for.
 *    `categoryToPlatform` therefore maps it to `null` ("PSN did not tell us
 *    something we can use") and — the one hard constraint here — it must
 *    NEVER map to `'psp'`, which would corrupt the platform of the owner's
 *    40 genuinely-PSP games the moment a PS-on-PC title synced.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { GamePlatform } from './taxonomy';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

const DURATION_PATTERN = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/;

/**
 * Converts an ISO-8601 duration string — PSN's `playDuration`, e.g.
 * `"PT228H56M33S"` — into an integer count of TENTHS OF AN HOUR, the same
 * unit `hours.ts` stores everywhere else in Games.
 *
 * This does NOT go through `hours.ts`'s `minutesToHoursTenths`: that
 * function's input is a MINUTE COUNT (Steam's `playtime_forever`), where
 * this input is an hours+minutes+seconds DURATION STRING. Routing it through
 * a minutes-shaped helper would mean computing a minutes intermediate for no
 * reason, so the whole conversion — hours, minutes, and seconds each
 * contributing their fraction of an hour, rounded once at the end — happens
 * directly here. `hours.ts` stays the only place that converts a plain
 * minute count; this stays the only place that parses this duration syntax.
 *
 * Unparseable input (including an empty string) returns `0` rather than
 * `NaN` — the same "degrade to zero on a malformed third-party field"
 * contract `minutesToHoursTenths` documents.
 */
export function parsePlayDuration(iso: string): number {
  const match = DURATION_PATTERN.exec(iso);
  if (match === null) return 0;

  const hoursPart = Number(match[1] ?? 0);
  const minutesPart = Number(match[2] ?? 0);
  const secondsPart = Number(match[3] ?? 0);

  const totalHours = hoursPart + minutesPart / 60 + secondsPart / 3600;
  return Math.round(totalHours * 10);
}

const CATEGORY_TO_PLATFORM: Readonly<Record<string, GamePlatform>> = {
  ps4_game: 'ps4',
  ps5_native_game: 'ps5',
};

/**
 * Maps a PSN `category` value to this app's `GamePlatform`. Only the two
 * categories confirmed above are mapped; every other value — including
 * `pspc_game` and `unknown` — returns `null`, meaning "PSN did not tell us
 * something we can use." A `null` platform is a signal to the (later) sync
 * engine to leave the stored platform alone, never a guess. See the module
 * header for why `pspc_game` in particular must never resolve to `'psp'`.
 *
 * `unknown` is deliberately NOT mapped here even though the owner's real
 * account proves it is real game data (see `isGameCategory` below) — its
 * title IDs are the ones `platformFromTitleId` resolves instead, at the
 * `toPlayedTitles` call site.
 */
export function categoryToPlatform(category: string): GamePlatform | null {
  return CATEGORY_TO_PLATFORM[category] ?? null;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * SIX `category` VALUES OBSERVED ON THE OWNER'S REAL PSN ACCOUNT (verified
 * live against `getUserPlayedGames`, 2026-08-25, 87 played titles total):
 *
 *   category                    count   what it actually is
 *   ─────────────────────────────────────────────────────────────────────
 *   ps4_game                       36   games
 *   ps5_native_game                 28   games
 *   unknown                         13   REAL GAMES — e.g. Cyberpunk 2077
 *                                        (CUSA16596_00), Control
 *                                        (CUSA11461_00), inFAMOUS™ Second
 *                                        Son (CUSA00223_00)
 *   ps4_videoservice_web_app         7   apps — Netflix (357h), YouTube
 *                                        (642h), Prime Video, Spotify
 *   ps4_nongame_mini_app             2   apps
 *   not_found                        1   unresolvable
 *
 * Committed, Netflix's and YouTube's hundreds of "played" hours would dwarf
 * every real game in the owner's library (their most-played real game is
 * 170h) — a media app is not a game and must never be staged as a
 * `new_game`.
 *
 * A PATTERN, not a fixed deny-list of the two app values seen above: a
 * category is excluded when it CONTAINS "app" (covers both
 * `ps4_videoservice_web_app` and `ps4_nongame_mini_app`, and any future PSN
 * app category a fixed list would miss) or equals `not_found` (PSN
 * couldn't resolve the title at all — nothing useful to stage either).
 * Every other value — `unknown` included, despite its name — passes
 * through, per the live evidence above.
 * ─────────────────────────────────────────────────────────────────────────────
 */
function isGameCategory(category: string): boolean {
  return category !== 'not_found' && !category.includes('app');
}

/**
 * Falls back to the PSN title-ID prefix when `categoryToPlatform` returns
 * `null` — i.e. when PSN's `category` field didn't tell us anything usable
 * (this app's own `'unknown'` case, or a genuinely new category).
 *
 * Verified live: Cyberpunk 2077 on PS5 is `PPSA03974_00` under category
 * `ps5_native_game` (`categoryToPlatform` already resolves this one, so the
 * fallback never runs); the SAME owner's PS4 copy is `CUSA16596_00` under
 * category `unknown` (`categoryToPlatform` returns `null` — this is exactly
 * the case this fallback exists for). `CUSA…` -> `ps4`, `PPSA…` -> `ps5`.
 *
 * Anything else — including no recognisable prefix at all — stays `null`.
 * In particular this must NEVER resolve `'psp'`: see the module header on
 * why a guessed PSP platform would corrupt the owner's genuinely-PSP rows.
 */
function platformFromTitleId(titleId: string): GamePlatform | null {
  if (titleId.startsWith('CUSA')) return 'ps4';
  if (titleId.startsWith('PPSA')) return 'ps5';
  return null;
}

export interface PsnPlayedTitle {
  readonly titleId: string;
  readonly name: string;
  readonly platform: GamePlatform | null;
  readonly hoursTenths: number;
  readonly firstPlayedYear: number | null;
  readonly lastPlayedAt: string | null;
}

function yearOf(dateTime: unknown): number | null {
  if (typeof dateTime !== 'string' || dateTime.length < 4) return null;
  const year = Number(dateTime.slice(0, 4));
  return Number.isInteger(year) ? year : null;
}

/**
 * Shapes a `getUserPlayedGames` response (`{ titles: [...], ... }`) into
 * `PsnPlayedTitle[]`. Defensive by construction, exactly like `steam.ts`'s
 * `toOwnedGames` and `metadata.ts`'s `toSuggestions`: a third-party payload
 * is untrusted shape, not a typed contract, so a malformed entry is skipped
 * rather than thrown on, and a payload with no `titles` array at all — the
 * shape of an error response as much as a genuinely empty page — collapses
 * to `[]`.
 *
 * A title whose category is not a game (`isGameCategory` above) is skipped
 * here too, at the same point malformed entries are — a media app has no
 * more business becoming a `PsnPlayedTitle` than a `null` entry does.
 */
export function toPlayedTitles(payload: unknown): PsnPlayedTitle[] {
  const titles = asRecord(payload)?.titles;
  if (!Array.isArray(titles)) return [];

  return titles.flatMap((entry): PsnPlayedTitle[] => {
    const record = asRecord(entry);
    if (record === null) return [];

    const titleId = record.titleId;
    const name = record.name;
    if (typeof titleId !== 'string' || titleId === '' || typeof name !== 'string' || name === '') return [];

    const category = typeof record.category === 'string' ? record.category : '';
    if (!isGameCategory(category)) return [];

    const playDuration = typeof record.playDuration === 'string' ? record.playDuration : '';
    const lastPlayedAt =
      typeof record.lastPlayedDateTime === 'string' && record.lastPlayedDateTime !== ''
        ? record.lastPlayedDateTime
        : null;

    return [
      {
        titleId,
        name,
        platform: categoryToPlatform(category) ?? platformFromTitleId(titleId),
        hoursTenths: parsePlayDuration(playDuration),
        firstPlayedYear: yearOf(record.firstPlayedDateTime),
        lastPlayedAt,
      },
    ];
  });
}

export interface PsnTrophyTitle {
  readonly npCommunicationId: string;
  readonly name: string;
  readonly earned: number;
  readonly total: number;
  readonly platinum: boolean;
}

/**
 * Sums a `TrophyCounts` object's four grades (`bronze`, `silver`, `gold`,
 * `platinum` — the last a 0/1 flag, not a count) into one number. Returns
 * `null`, not `0`, when the shape is missing or any grade isn't a number —
 * `0` would misrepresent "this title genuinely defines/earned zero
 * trophies" as a fact this malformed payload never actually asserted, the
 * same distinction `steam.ts`'s `toAchievementCounts` draws for a game with
 * no achievement data at all.
 */
function sumTrophyCounts(counts: unknown): number | null {
  const record = asRecord(counts);
  if (record === null) return null;

  const { bronze, silver, gold, platinum } = record;
  if (typeof bronze !== 'number' || typeof silver !== 'number' || typeof gold !== 'number' || typeof platinum !== 'number') {
    return null;
  }
  return bronze + silver + gold + platinum;
}

function earnedPlatinum(earnedTrophies: unknown): boolean {
  const record = asRecord(earnedTrophies);
  return record !== null && record.platinum === 1;
}

/**
 * Shapes a `getUserTitles` response (`{ trophyTitles: [...], ... }`) into
 * `PsnTrophyTitle[]`. A title whose `definedTrophies`/`earnedTrophies`
 * aren't real `TrophyCounts` shapes is skipped rather than reported with a
 * fabricated `0`, for the same reason `sumTrophyCounts` returns `null`
 * rather than `0` on a malformed count.
 */
export function toTrophyTitles(payload: unknown): PsnTrophyTitle[] {
  const trophyTitles = asRecord(payload)?.trophyTitles;
  if (!Array.isArray(trophyTitles)) return [];

  return trophyTitles.flatMap((entry): PsnTrophyTitle[] => {
    const record = asRecord(entry);
    if (record === null) return [];

    const npCommunicationId = record.npCommunicationId;
    const name = record.trophyTitleName;
    if (typeof npCommunicationId !== 'string' || npCommunicationId === '' || typeof name !== 'string' || name === '') {
      return [];
    }

    const total = sumTrophyCounts(record.definedTrophies);
    const earned = sumTrophyCounts(record.earnedTrophies);
    if (total === null || earned === null) return [];

    return [
      {
        npCommunicationId,
        name,
        earned,
        total,
        platinum: earnedPlatinum(record.earnedTrophies),
      },
    ];
  });
}
