/**
 * "Upcoming games" shaping and month-grouping.
 *
 * Pure, framework-free, like every other module under `src/server/games/` —
 * see that directory's own rule in CLAUDE.md. Imports nothing outside this
 * directory: `coverUrl` is the one thing reused from `metadata.ts`, kept
 * consistent with how the library's own game-suggestion flow builds cover
 * art URLs.
 *
 * The query this module's input comes from (`buildUpcomingQuery` in
 * `metadata.ts`, POSTed by `fetchUpcomingGames` in
 * `src/server/db/games/igdb.ts`) is scoped to `platforms = (167,6)` — PS5 or
 * PC — but that is an "any of" filter on the GAME, not on its individual
 * `release_dates` rows. A qualifying game can still carry `release_dates`
 * rows for Switch, Xbox, or any other platform, which this module must
 * ignore both when picking a release month and when deciding which
 * platforms to display — confirmed live: Grand Theft Auto VI's own
 * `release_dates` include a `platform: 169` (Xbox Series X) row alongside
 * its `167` (PS5) row.
 *
 * The two real data hazards this module was built to handle, both
 * confirmed against live IGDB data before writing a line of grouping logic:
 *
 *   1. IGDB returns `release_dates` rows dated in the PAST even when a
 *      game's overall `first_release_date` is in the future (the query
 *      itself only filters on `first_release_date`, not on any individual
 *      release row). Live probe: "The Expanse: Osiris Reborn" — a
 *      first_release_date-future game — carries `release_dates` rows dated
 *      April 2026 while the probe ran in August 2026. `groupByMonth` rejects
 *      any exact-month row earlier than the current calendar month.
 *   2. Roughly HALF of qualifying games have no exact month at all — only
 *      year, quarter, or TBD precision (18 of 45 at hype floor 30, live-
 *      measured). The trailing "Later / TBD" bucket is load-bearing, not an
 *      edge case: a game whose only qualifying `release_dates` rows are
 *      non-exact (`date_format` 2–7), or whose only exact rows were all
 *      rejected as past, lands there rather than being dropped.
 *
 * Also observed live: a `date_format` 2 (year-only) row still carries a
 * non-null `m` (IGDB fills it with a placeholder — observed value 12,
 * i.e. December, on multiple 2026 year-only rows). That `m` is NOT a real
 * month and must never be read for anything but `date_format` 0
 * (YYYYMMDD) or 1 (YYYYMM) rows — see `earliestQualifyingMonth`.
 */

import { coverUrl } from './metadata';

/** IGDB's numeric platform ids for the two platforms this app tracks upcoming releases for. */
const PLATFORM_IDS = { ps5: 167, pc: 6 } as const;

export type UpcomingPlatform = keyof typeof PLATFORM_IDS;

const QUALIFYING_PLATFORM_IDS: ReadonlySet<number> = new Set(Object.values(PLATFORM_IDS));

/** IGDB `date_format` values that carry an exact, meaningful month. See `/date_formats`: 0 = YYYYMMDD, 1 = YYYYMM. */
const EXACT_MONTH_DATE_FORMATS: ReadonlySet<number> = new Set([0, 1]);

/** One `release_dates` row, already filtered to a qualifying (PS5/PC) platform. Internal — used only by `groupByMonth`. */
interface RawReleaseDate {
  readonly year: number;
  /** 1-12. Only meaningful when `dateFormat` is 0 or 1 — see `EXACT_MONTH_DATE_FORMATS`. */
  readonly month: number | null;
  /**
   * 1-31, and meaningful ONLY when `dateFormat` is 0 (`YYYYMMDD`). A
   * `date_format` 1 row is month-precision by definition and carries no real
   * day, exactly as it carries no real day-of-week — do not read this field
   * for one, and do not fall back to 1.
   *
   * Derived from IGDB's `date` (Unix seconds), NOT from a `d` field — there
   * is no such field, and querying for one returns 200 with the key absent
   * rather than an error. See `metadata.ts`'s field list.
   */
  readonly day: number | null;
  readonly dateFormat: number;
}

export interface UpcomingGame {
  readonly igdbId: number;
  readonly title: string;
  readonly coverUrl: string | null;
  readonly hypes: number;
  /**
   * Every PS5/PC platform IGDB lists this game for, from the game's own
   * top-level `platforms` relation — independent of whether a matching
   * `release_dates` row with an exact date exists yet for each one.
   */
  readonly platforms: readonly UpcomingPlatform[];
  /** This game's `release_dates` rows, already filtered to platforms 167/6. Consumed only by `groupByMonth`. */
  readonly releaseDates: readonly RawReleaseDate[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The game's top-level `platforms` relation, filtered to the two ids this app tracks, deduped, order-stable. */
function platformsFrom(value: unknown): UpcomingPlatform[] {
  if (!Array.isArray(value)) return [];
  const found = new Set<UpcomingPlatform>();
  for (const entry of value) {
    if (entry === PLATFORM_IDS.ps5) found.add('ps5');
    else if (entry === PLATFORM_IDS.pc) found.add('pc');
  }
  return [...found];
}

/** The game's `release_dates` relation, filtered to rows for a qualifying (PS5/PC) platform. Malformed rows are skipped, never thrown on. */
function releaseDatesFrom(value: unknown): RawReleaseDate[] {
  if (!Array.isArray(value)) return [];
  const result: RawReleaseDate[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record === null) continue;
    const platformId = readNumber(record.platform);
    if (platformId === null || !QUALIFYING_PLATFORM_IDS.has(platformId)) continue;
    const year = readNumber(record.y);
    const dateFormat = readNumber(record.date_format);
    if (year === null || dateFormat === null) continue;
    const month = readNumber(record.m);
    result.push({ year, month, day: dayFrom(record.date, year, month), dateFormat });
  }
  return result;
}

/**
 * The day-of-month IGDB's `date` (Unix SECONDS) falls on, or `null`.
 *
 * Read in UTC throughout. A `Date` built from a Unix timestamp reports its
 * day in the RUNTIME's timezone, so `getDate()` on a server west of UTC would
 * return the previous day for every midnight-UTC release — the same hazard
 * this module's header comment already flags for raw IGDB dates.
 *
 * The derived year/month are checked against the row's own `y`/`m` before the
 * day is trusted. They should always agree; when they don't, the row is
 * internally inconsistent and the honest answer is "no day," not a day pulled
 * from a different month than the one this game is being bucketed into.
 */
function dayFrom(value: unknown, year: number, month: number | null): number | null {
  const seconds = readNumber(value);
  if (seconds === null || month === null) return null;

  const at = new Date(seconds * 1000);
  if (Number.isNaN(at.getTime())) return null;
  if (at.getUTCFullYear() !== year || at.getUTCMonth() + 1 !== month) return null;

  return at.getUTCDate();
}

/**
 * Shapes a `/v4/games` JSON response (from `buildUpcomingQuery`) into
 * `UpcomingGame[]`. Defensive by construction, exactly like `toSuggestions`
 * in `metadata.ts`: a missing or wrong-typed field drops that one entry (or
 * degrades a sub-field to `null`/`[]`), never throws.
 */
export function toUpcomingGames(payload: unknown): UpcomingGame[] {
  if (!Array.isArray(payload)) return [];

  return payload.flatMap((entry): UpcomingGame[] => {
    const record = asRecord(entry);
    if (record === null) return [];

    const igdbId = readNumber(record.id);
    const title = readString(record.name);
    if (igdbId === null || title === null) return [];

    const imageId = readString(asRecord(record.cover)?.image_id);

    return [
      {
        igdbId,
        title,
        coverUrl: imageId === null ? null : coverUrl(imageId),
        // The query filters `hypes >= floor` server-side, so this is
        // effectively always present — the fallback only guards a
        // malformed/test payload from producing NaN sort order.
        hypes: readNumber(record.hypes) ?? 0,
        platforms: platformsFrom(record.platforms),
        releaseDates: releaseDatesFrom(record.release_dates),
      },
    ];
  });
}

export interface UpcomingMonthGame {
  readonly igdbId: number;
  readonly title: string;
  readonly coverUrl: string | null;
  readonly hypes: number;
  readonly platforms: readonly UpcomingPlatform[];
  /**
   * `YYYY-MM-DD`. The day is REAL when `releasePrecision` is `'day'` (IGDB
   * `date_format` 0) and a `01` placeholder when it is `'month'` — always
   * read the two together, never the date alone. Present only when the game
   * landed in a real month; `null` for every game in the trailing Later/TBD
   * group. Ready to persist straight into `games.release_date` from the
   * wishlist flow.
   */
  readonly releaseDate: string | null;
  /** `null` exactly when `releaseDate` is. See `games.release_precision` in `schema.ts`. */
  readonly releasePrecision: 'day' | 'month' | null;
}

export interface UpcomingMonth {
  /** `YYYY-MM` for a real month, `'later'` for the trailing bucket. */
  readonly key: string;
  /** e.g. `"November 2026"`, or `"Later / TBD"` for the trailing bucket. */
  readonly label: string;
  readonly games: readonly UpcomingMonthGame[];
}

const LATER_KEY = 'later';
const LATER_LABEL = 'Later / TBD';

// Exported for reuse by `upcoming-view.tsx`'s per-card release-date text —
// keeps month-name formatting in exactly one place rather than a second
// local copy in the client component.
export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

/** True when `(year, month)` is strictly before `now`'s calendar month — i.e. it has already fully elapsed. */
function isPastMonth(year: number, month: number, now: Date): boolean {
  const nowYear = now.getUTCFullYear();
  const nowMonth = now.getUTCMonth() + 1;
  return year < nowYear || (year === nowYear && month < nowMonth);
}

/**
 * The earliest EXACT month (`date_format` 0 or 1) among a game's qualifying
 * `release_dates` rows that has not already elapsed. Returns `null` when no
 * such row exists — either because every row is year/quarter/TBD precision,
 * or because every exact row was rejected as past (see the module header's
 * hazard #1) — which is exactly the signal `groupByMonth` uses to route a
 * game to Later/TBD instead of a real month.
 */
function earliestQualifyingMonth(
  releaseDates: readonly RawReleaseDate[],
  now: Date,
): { readonly year: number; readonly month: number; readonly day: number | null } | null {
  let best: { year: number; month: number; day: number | null } | null = null;
  for (const entry of releaseDates) {
    if (!EXACT_MONTH_DATE_FORMATS.has(entry.dateFormat) || entry.month === null) continue;
    if (isPastMonth(entry.year, entry.month, now)) continue;
    if (
      best === null ||
      entry.year < best.year ||
      (entry.year === best.year && entry.month < best.month)
    ) {
      // The day rides along only for `date_format` 0. Comparison stays at
      // MONTH granularity on purpose: two rows in the same month are already
      // equivalent for bucketing, and preferring the earlier day between them
      // would change which platform's date wins for no stated reason.
      best = {
        year: entry.year,
        month: entry.month,
        day: entry.dateFormat === 0 ? entry.day : null,
      };
    }
  }
  return best;
}

interface MonthBucket {
  readonly year: number;
  readonly month: number | null;
  readonly games: UpcomingMonthGame[];
}

/**
 * Groups upcoming games by their earliest qualifying release month, plus a
 * trailing Later/TBD bucket for everything else. A game with several
 * qualifying release dates (PS5 in November, PC the following February)
 * appears exactly ONCE, in its earliest month, carrying every PS5/PC
 * platform it lists — never once per release row.
 *
 * `now` is a parameter (not read internally via `new Date()`) so the past-
 * month rejection and "which games count as Later/TBD" are both
 * deterministic and unit-testable.
 */
export function groupByMonth(games: readonly UpcomingGame[], now: Date): UpcomingMonth[] {
  const buckets = new Map<string, MonthBucket>();

  for (const game of games) {
    const earliest = earliestQualifyingMonth(game.releaseDates, now);
    const displayGame: UpcomingMonthGame = {
      igdbId: game.igdbId,
      title: game.title,
      coverUrl: game.coverUrl,
      hypes: game.hypes,
      platforms: game.platforms,
      releaseDate:
        earliest === null
          ? null
          : `${monthKey(earliest.year, earliest.month)}-${String(earliest.day ?? 1).padStart(2, '0')}`,
      // `-01` on a month-precision row is a PLACEHOLDER, not a claim. This is
      // the field that says which — see `games.release_precision`'s own
      // comment in `schema.ts` for why it is stored rather than inferred from
      // the day number.
      releasePrecision: earliest === null ? null : earliest.day === null ? 'month' : 'day',
    };

    const key = earliest === null ? LATER_KEY : monthKey(earliest.year, earliest.month);
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, {
        year: earliest?.year ?? 0,
        month: earliest?.month ?? null,
        games: [displayGame],
      });
    } else {
      bucket.games.push(displayGame);
    }
  }

  const sortByHypeDesc = (a: UpcomingMonthGame, b: UpcomingMonthGame): number => b.hypes - a.hypes;

  const monthGroups = [...buckets.entries()]
    .filter(([key]) => key !== LATER_KEY)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, bucket]): UpcomingMonth => ({
      key,
      // Non-null by construction: only the Later/TBD bucket (filtered out
      // above) ever has `month: null`.
      label: monthLabel(bucket.year, bucket.month as number),
      games: [...bucket.games].sort(sortByHypeDesc),
    }));

  const laterBucket = buckets.get(LATER_KEY);
  if (laterBucket !== undefined) {
    monthGroups.push({
      key: LATER_KEY,
      label: LATER_LABEL,
      games: [...laterBucket.games].sort(sortByHypeDesc),
    });
  }

  return monthGroups;
}
