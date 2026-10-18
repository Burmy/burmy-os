import { MONTH_NAMES } from './upcoming';

/**
 * How precisely a stored release date is known. Mirrors
 * `games.release_precision` — see that column's comment in `schema.ts` for
 * why IGDB's `date_format` is recorded rather than inferred from the day.
 */
export type ReleasePrecision = 'day' | 'month';

/** Beyond this many days out, a countdown stops being useful and becomes a date. */
const COUNTDOWN_HORIZON_DAYS = 60;

const MONTH_ABBR = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function parseParts(releaseDate: string): { year: number; month: number; day: number } | null {
  const [yearPart, monthPart, dayPart] = releaseDate.split('-');
  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  return { year, month, day };
}

/**
 * Has this release date passed?
 *
 * Day precision: the day is today or behind us (a game out today IS out).
 * Month precision: the whole month has to be behind us — IGDB pinned no day,
 * so a "November 2026" game is not out on 2 November just because the
 * stored placeholder day is the 1st. That placeholder is exactly what made
 * the old auto-flip promote month-precision games a day into their month.
 *
 * `now` is a parameter so every branch is deterministic and testable.
 */
export function isReleased(releaseDate: string, precision: ReleasePrecision, now: Date): boolean {
  const parts = parseParts(releaseDate);
  if (parts === null) return false;

  if (precision === 'month') {
    const nowYear = now.getUTCFullYear();
    const nowMonth = now.getUTCMonth() + 1;
    return parts.year < nowYear || (parts.year === nowYear && parts.month < nowMonth);
  }

  const releaseUtc = Date.UTC(parts.year, parts.month - 1, parts.day);
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return releaseUtc <= todayUtc;
}

/**
 * The short phrase a wishlist card shows for a game that hasn't launched:
 * "in 12 days" when it's close, "Sep 18, 2026" when it's far, "November 2026"
 * when IGDB only knows the month — and "Out now" once it has.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS GAMES-LOCAL AND NOT IN `src/lib/format-date.ts`.
 *
 * That module imports `MONTH_ABBREVIATIONS` from `@/server/finance/grid`, and
 * CLAUDE.md forbids Finance and Games code from importing each other — reusing
 * it would put a Finance import in the Games bundle. `src/lib/relative-time.ts` already
 * records this exact reasoning for itself, and is past-tense ("3 days ago"), so
 * it does not fit a countdown either.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `precision` is not optional and not defaulted. A month-precision date is
 * stored as `YYYY-MM-01`, so a caller that forgot to pass it would confidently
 * print "Nov 1, 2026" for a game IGDB never claimed a launch day for. Making it
 * required means that mistake cannot compile.
 *
 * `now` is a parameter rather than an internal `new Date()` so every branch is
 * deterministic and testable, matching `groupByMonth`.
 */
export function formatReleaseCountdown(
  /** `YYYY-MM-DD`. The day is a placeholder unless `precision` is `'day'`. */
  releaseDate: string,
  precision: ReleasePrecision,
  now: Date,
): string {
  const parts = parseParts(releaseDate);
  if (parts === null) return '';
  const { year, month, day } = parts;

  if (precision === 'month') {
    // No day exists to count down to, so this never counts down — saying
    // "in 12 days" about a date IGDB pinned only to a month would invent
    // a launch day. Once the month is behind us it is simply out.
    if (isReleased(releaseDate, precision, now)) return 'Out now';
    return `${MONTH_NAMES[month - 1] ?? ''} ${year}`.trim();
  }

  // Both sides floored to UTC midnight before subtracting, so the answer is a
  // whole number of CALENDAR days rather than a fraction of elapsed time — a
  // release 25 hours away is "in 1 day", not "in 1 day" only until the clock
  // rolls past the hour it was rendered.
  const releaseUtc = Date.UTC(year, month - 1, day);
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.round((releaseUtc - todayUtc) / 86_400_000);

  if (days < 0) return 'Out now';
  if (days === 0) return 'Out today';
  if (days === 1) return 'Tomorrow';
  if (days <= COUNTDOWN_HORIZON_DAYS) return `in ${days} days`;
  return `${MONTH_ABBR[month - 1] ?? ''} ${day}, ${year}`;
}

/** The three fields `sortWishlist` reads — a `Game` satisfies it. */
export interface WishlistSortable {
  readonly title: string;
  readonly releaseDate: string | null;
  readonly releasePrecision: ReleasePrecision | null;
}

/**
 * The order the "Your wishlist" section lists wanted games in: released
 * ones first (they are the ones to act on — buy, start, or admit you won't),
 * then dated ones soonest first, then games with no date at all, each group
 * alphabetical. Pure, so the Upcoming view can hand it `new Date()` once per
 * render and a test can hand it any instant it likes.
 */
export function sortWishlist<T extends WishlistSortable>(games: readonly T[], now: Date): T[] {
  const rank = (game: T): 0 | 1 | 2 => {
    if (game.releaseDate === null || game.releasePrecision === null) return 2;
    return isReleased(game.releaseDate, game.releasePrecision, now) ? 0 : 1;
  };

  return [...games].sort((a, b) => {
    const rankA = rank(a);
    const rankB = rank(b);
    if (rankA !== rankB) return rankA - rankB;
    if (rankA === 1) {
      const byDate = (a.releaseDate ?? '').localeCompare(b.releaseDate ?? '');
      if (byDate !== 0) return byDate;
    }
    return a.title.localeCompare(b.title);
  });
}
