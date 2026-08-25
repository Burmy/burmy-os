/**
 * Every number the Games dashboard shows, derived from the library at read
 * time.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOTHING HERE IS EVER STORED.
 *
 * The spreadsheet this module replaces kept a hand-maintained Year →
 * Games/Hours/Trophies rollup, and it had already drifted out of sync with its
 * own rows by the time it was imported — two copies of the table disagreed.
 * That is the failure mode this module exists to make impossible: the rollup is
 * a function of the library, recomputed on every render.
 *
 * Pure TypeScript. No React, no Next, no database — same boundary rule as
 * `src/server/finance/`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { type PlayYearRow, attributeHours } from './play-years';
import type { GameOwnership, GamePlatform, GameStatus } from './taxonomy';

export type { GameOwnership, GamePlatform, GameStatus };

/** The projection every stat function reads. Deliberately narrower than the full row. */
export interface GameStatRow {
  readonly id: string;
  readonly title: string;
  readonly platform: GamePlatform;
  readonly ownership: GameOwnership | null;
  readonly developer: string | null;
  readonly publisher: string | null;
  readonly genre: string | null;
  readonly coverUrl: string | null;
  readonly status: GameStatus;
  readonly rating: number | null;
  readonly hoursTenths: number | null;
  readonly firstPlayedYear: number | null;
  readonly achievementsUnlocked: number | null;
  readonly achievementsTotal: number | null;
  readonly platinum: boolean;
  readonly metacritic: number | null;
  readonly priceCents: number | null;
}

export interface YearlyBreakdownRow {
  readonly year: number;
  /** Games whose `firstPlayedYear` is this year. Sums to the library total across years. */
  readonly startedCount: number;
  /**
   * Distinct games with hours attributed to this year. Deliberately does NOT
   * sum to the library total: a game played across two years is genuinely
   * played in both, and counting it once would hide that.
   */
  readonly playedCount: number;
  readonly hoursTenths: number;
  readonly achievements: number;
  /** Hours vs the previous year present in the data. Null for the earliest year. */
  readonly hoursChangeTenths: number | null;
}

export interface YearlyBreakdown {
  readonly rows: readonly YearlyBreakdownRow[];
  /** See `AttributionResult.unattributedTenths`. Rendered as its own line, never folded into a year. */
  readonly unattributedTenths: number;
}

export interface LibrarySummary {
  readonly totalGames: number;
  readonly totalHoursTenths: number;
  readonly backlogCount: number;
  readonly playingCount: number;
  readonly playedCount: number;
  /** Mean of rated games only, 1-5. Null when nothing is rated. */
  readonly averageRating: number | null;
  /** Count of games with the owner's own `platinum` flag set. */
  readonly platinumCount: number;
  /** Mean `hoursTenths` over games that HAVE logged hours. Null when nothing has any hours logged — an unplayed backlog entry is excluded, not counted as a zero. */
  readonly averageHoursTenthsPerGame: number | null;
  /** Mean `metacritic` over games that have one. Null when none do. */
  readonly averageMetacritic: number | null;
}

export interface FinancialSummary {
  /** Sum of `priceCents` over games with a price recorded. Missing prices contribute nothing, never zero. */
  readonly totalSpendCents: number;
  /** Mean price over games that HAVE a price recorded. Null when nothing does. */
  readonly averagePriceCents: number | null;
  /** `totalSpendCents` / total hours played (not tenths). Null when nothing has any hours logged — there is no rate to report, not a rate of zero. */
  readonly costPerHourCents: number | null;
  readonly backlogCount: number;
  /** Sum of `priceCents` across backlog-status games only — the money sitting unplayed. Missing prices contribute nothing. */
  readonly backlogValueCents: number;
}

export interface DistributionSlice {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  /** Share of the rows that HAD a key, 0-100. */
  readonly percent: number;
}

export interface Callouts {
  readonly topDeveloper: { readonly name: string; readonly hoursTenths: number } | null;
  readonly bestYear: { readonly year: number; readonly hoursTenths: number } | null;
}

/**
 * Year → games/hours/achievements, newest first. No `currentYear` parameter —
 * this module has no notion of "today"; a caller that wants to highlight the
 * in-progress year passes it in separately when rendering these rows, not
 * when building them.
 *
 * Hours come from `attributeHours`, so a game played across two years lands in
 * both. Achievements do NOT: they stay on `firstPlayedYear` because no source
 * anywhere — the library, Steam, or PSN — records which year a trophy was
 * earned in, and splitting them proportionally would fabricate data.
 */
export function buildYearlyBreakdown(
  rows: readonly GameStatRow[],
  playYears: readonly PlayYearRow[],
): YearlyBreakdown {
  const { attributions, unattributedTenths } = attributeHours(rows, playYears);

  const byYear = new Map<
    number,
    { startedCount: number; playedGames: Set<string>; hoursTenths: number; achievements: number }
  >();

  function bucket(year: number): {
    startedCount: number;
    playedGames: Set<string>;
    hoursTenths: number;
    achievements: number;
  } {
    const existing = byYear.get(year);
    if (existing !== undefined) return existing;
    const created = { startedCount: 0, playedGames: new Set<string>(), hoursTenths: 0, achievements: 0 };
    byYear.set(year, created);
    return created;
  }

  for (const attribution of attributions) {
    const target = bucket(attribution.year);
    target.hoursTenths += attribution.hoursTenths;
    target.playedGames.add(attribution.gameId);
  }

  for (const row of rows) {
    // A retro entry with no year is not year zero — it has no place in a
    // year-by-year comparison and is excluded rather than bucketed.
    if (row.firstPlayedYear === null) continue;
    const target = bucket(row.firstPlayedYear);
    target.startedCount += 1;
    target.achievements += row.achievementsUnlocked ?? 0;
  }

  const ascending = [...byYear.entries()].sort((a, b) => a[0] - b[0]);

  const built = ascending
    .map(([year, data], index) => {
      const previous = index === 0 ? null : ascending[index - 1]![1];
      return {
        year,
        startedCount: data.startedCount,
        playedCount: data.playedGames.size,
        hoursTenths: data.hoursTenths,
        achievements: data.achievements,
        hoursChangeTenths: previous === null ? null : data.hoursTenths - previous.hoursTenths,
      };
    })
    .sort((a, b) => b.year - a.year);

  return { rows: built, unattributedTenths };
}

export function buildLibrarySummary(rows: readonly GameStatRow[]): LibrarySummary {
  const rated = rows.filter((row) => row.rating !== null);

  // Excluded from their averages entirely, not counted as a zero — the same
  // rule `averageRating` already follows: a game with no hours logged or no
  // Metacritic score is missing data, not a real zero to pull the mean down.
  const withHours = rows.filter((row) => row.hoursTenths !== null);
  const withMetacritic = rows.filter((row) => row.metacritic !== null);

  return {
    totalGames: rows.length,
    totalHoursTenths: rows.reduce((total, row) => total + (row.hoursTenths ?? 0), 0),
    backlogCount: rows.filter((row) => row.status === 'backlog').length,
    playingCount: rows.filter((row) => row.status === 'playing').length,
    playedCount: rows.filter((row) => row.status === 'played').length,
    averageRating:
      rated.length === 0 ? null : rated.reduce((sum, row) => sum + (row.rating ?? 0), 0) / rated.length,
    platinumCount: rows.filter((row) => row.platinum).length,
    averageHoursTenthsPerGame:
      withHours.length === 0
        ? null
        : withHours.reduce((sum, row) => sum + (row.hoursTenths ?? 0), 0) / withHours.length,
    averageMetacritic:
      withMetacritic.length === 0
        ? null
        : withMetacritic.reduce((sum, row) => sum + (row.metacritic ?? 0), 0) / withMetacritic.length,
  };
}

/**
 * Money: what the library cost, what a game costs on average, what an hour of
 * play cost, and how much is sitting unplayed in the backlog. Every average
 * here is over games that HAVE the relevant value, exactly like
 * `buildLibrarySummary`'s `averageRating` — a game with no price recorded is
 * missing data, not a free game.
 */
export function buildFinancialSummary(rows: readonly GameStatRow[]): FinancialSummary {
  const priced = rows.filter((row) => row.priceCents !== null);
  const totalSpendCents = priced.reduce((sum, row) => sum + (row.priceCents ?? 0), 0);

  // Whole hours, not tenths — "cost per hour" is a dollars-per-hour rate, and
  // dividing by tenths-of-an-hour would silently report a figure ten times
  // too small.
  const totalHours = rows.reduce((sum, row) => sum + (row.hoursTenths ?? 0), 0) / 10;

  const backlog = rows.filter((row) => row.status === 'backlog');
  const backlogValueCents = backlog.reduce((sum, row) => sum + (row.priceCents ?? 0), 0);

  return {
    totalSpendCents,
    averagePriceCents: priced.length === 0 ? null : totalSpendCents / priced.length,
    costPerHourCents: totalHours === 0 ? null : totalSpendCents / totalHours,
    backlogCount: backlog.length,
    backlogValueCents,
  };
}

export function buildDistribution(
  rows: readonly GameStatRow[],
  keyOf: (row: GameStatRow) => string | null,
  labelOf: (key: string) => string,
): DistributionSlice[] {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const key = keyOf(row);
    if (key === null || key === '') continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (total === 0) return [];

  return [...counts.entries()]
    .map(([key, count]) => ({ key, label: labelOf(key), count, percent: (count / total) * 100 }))
    .sort((a, b) => b.count - a.count);
}

/**
 * `games.genre` is a single `text` column holding a comma-joined list —
 * `joinGenres` in `metadata.ts` writes `"Shooter, Adventure"` for a
 * multi-genre game, because that is the shape IGDB returns and the editor's
 * free-text field accepts. Splitting it back out at read time (never
 * migrating the column) is what turns "one bar per genre COMBINATION" —
 * `"Shooter, Adventure"`, `"Role-playing (RPG), Adventure"` and `"Adventure"`
 * rendering as three unrelated categories — into one bar per genre.
 *
 * `null` (no genre recorded) returns nothing, matching `buildDistribution`'s
 * own rule elsewhere: missing data is skipped, never bucketed as "Unknown".
 */
export function splitGenres(genre: string | null): readonly string[] {
  if (genre === null) return [];
  return genre
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Genre counts, one increment per individual genre a game lists rather than
 * per genre combination — see `splitGenres`. A game tagged `"Shooter,
 * Adventure"` contributes one count to Shooter and one to Adventure, so
 * `percent` here is share of genre TAGS, not share of games: a two-genre
 * game is counted twice, and shares are not expected to sum to 100% of the
 * library. Capped at the top `GENRE_CHART_LIMIT` genres plus one "Other"
 * bucket so a long tail of one-off genres can never blow the chart back up
 * the way the uncapped combination list used to.
 */

/** How many individual genres `buildGenreDistribution` shows before folding the rest into "Other". */
export const GENRE_CHART_LIMIT = 8;

export function buildGenreDistribution(rows: readonly GameStatRow[]): DistributionSlice[] {
  const counts = new Map<string, number>();

  for (const row of rows) {
    for (const genre of splitGenres(row.genre)) {
      counts.set(genre, (counts.get(genre) ?? 0) + 1);
    }
  }

  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (total === 0) return [];

  const slices = [...counts.entries()]
    .map(([key, count]) => ({ key, label: key, count, percent: (count / total) * 100 }))
    .sort((a, b) => b.count - a.count);

  return capDistributionSlices(slices, GENRE_CHART_LIMIT);
}

/**
 * Keeps the top `limit` slices (already sorted, largest first, by whatever
 * produced them) and folds everything past that into one "Other" bucket —
 * `count` and `percent` both sum across the folded slices, so the capped
 * list still adds up to the same total. Used both by `buildGenreDistribution`
 * and, independently, by `DistributionChart` itself as a structural backstop:
 * capping only where genre counts are built would leave platform/ownership
 * (or any future caller of `buildDistribution`) free to blow the chart back
 * up the same way genre once did.
 */
export function capDistributionSlices(slices: readonly DistributionSlice[], limit: number): DistributionSlice[] {
  if (slices.length <= limit) return [...slices];

  const kept = slices.slice(0, limit);
  const folded = slices.slice(limit);
  const otherCount = folded.reduce((sum, slice) => sum + slice.count, 0);
  const otherPercent = folded.reduce((sum, slice) => sum + slice.percent, 0);

  return [...kept, { key: '__other__', label: 'Other', count: otherCount, percent: otherPercent }];
}

/**
 * `topDeveloper` aggregates TOTAL hours per developer —
 * not year-scoped, so they read straight off `rows`. `bestYear` IS
 * year-scoped, and used to build its own `yearHours` map keyed on
 * `firstPlayedYear`, crediting a game's FULL total to a single year — the
 * same thing `buildYearlyBreakdown` used to do before play-year splits
 * existed, and exactly the bug this whole feature fixes everywhere else. That
 * left two disagreeing implementations: this callout said "2024, 591.7h"
 * while the Year-by-year table (built from `attributeHours`) said "2024,
 * 579.7h" for the very same library. Rather than reimplementing attribution
 * a second time here, `bestYear` now takes the already-computed
 * `YearlyBreakdownRow[]` — the same rows the table renders — and just picks
 * the max by `hoursTenths`. One attribution implementation, not two kept in
 * sync by hand.
 */
export function findCallouts(rows: readonly GameStatRow[], yearlyRows: readonly YearlyBreakdownRow[]): Callouts {
  const played = rows.filter((row) => (row.hoursTenths ?? 0) > 0);

  const developerHours = new Map<string, number>();
  for (const row of played) {
    if (row.developer === null || row.developer === '') continue;
    developerHours.set(row.developer, (developerHours.get(row.developer) ?? 0) + (row.hoursTenths ?? 0));
  }
  const topDeveloperEntry = [...developerHours.entries()].sort((a, b) => b[1] - a[1])[0];

  const bestYearRow = yearlyRows.reduce<YearlyBreakdownRow | null>(
    (best, row) => (best === null || row.hoursTenths > best.hoursTenths ? row : best),
    null,
  );

  return {
    topDeveloper:
      topDeveloperEntry === undefined ? null : { name: topDeveloperEntry[0], hoursTenths: topDeveloperEntry[1] },
    bestYear: bestYearRow === null ? null : { year: bestYearRow.year, hoursTenths: bestYearRow.hoursTenths },
  };
}

/** Which stat a leaderboard ranks by. */
export type LeaderboardMetric = 'hours' | 'rating' | 'trophies' | 'costPerHour';

export interface LeaderboardEntry {
  readonly id: string;
  readonly title: string;
  readonly coverUrl: string | null;
  readonly platform: GamePlatform;
  /**
   * Raw, in the metric's own unit — tenths of an hour, a 1-5 rating, a trophy
   * count, or cents per hour. Formatting belongs to the caller, so this module
   * stays free of display concerns.
   */
  readonly value: number;
}

/**
 * The top `limit` games by one stat, best first.
 *
 * Every metric EXCLUDES games that have no value for it rather than ranking
 * them as zero. An unrated game is not a one-star game, a game nobody has
 * played is not the worst value, and treating a missing figure as a real
 * bottom-of-the-table score is exactly how a leaderboard starts lying. Ties
 * break alphabetically so a panel does not reshuffle between renders.
 *
 * Ties break on hours played before the title, so an equally-rated pair
 * surfaces the one actually played more.
 *
 * `costPerHour` is the one metric where LOWER is better, and it is
 * deliberately cents-per-hour rather than hours-per-dollar: it formats with
 * `money.ts`'s existing helper, and "$0.42 an hour" is how people actually
 * talk about whether a game was worth it. It requires BOTH a real price and
 * real play time — a free game has no cost per hour, and an unplayed one
 * would divide by zero.
 */
export function buildLeaderboard(
  rows: readonly GameStatRow[],
  metric: LeaderboardMetric,
  limit: number,
): LeaderboardEntry[] {
  const scored: { readonly row: GameStatRow; readonly value: number }[] = [];

  for (const row of rows) {
    const hoursTenths = row.hoursTenths ?? 0;

    if (metric === 'hours') {
      if (hoursTenths <= 0) continue;
      scored.push({ row, value: hoursTenths });
    } else if (metric === 'rating') {
      if (row.rating === null) continue;
      scored.push({ row, value: row.rating });
    } else if (metric === 'trophies') {
      if (row.achievementsUnlocked === null || row.achievementsUnlocked <= 0) continue;
      scored.push({ row, value: row.achievementsUnlocked });
    } else {
      if (row.priceCents === null || row.priceCents <= 0 || hoursTenths <= 0) continue;
      // cents per hour = priceCents / (hoursTenths / 10)
      scored.push({ row, value: Math.round((row.priceCents * 10) / hoursTenths) });
    }
  }

  const lowerIsBetter = metric === 'costPerHour';
  scored.sort((a, b) => {
    const diff = lowerIsBetter ? a.value - b.value : b.value - a.value;
    if (diff !== 0) return diff;

    // Ties break on HOURS before falling back to the title. This matters most
    // for `rating`, where a 160-game library has dozens of 5-star entries and
    // an alphabetical tie-break would render "your three favourite games" as
    // "the three 5-star games nearest the top of the alphabet" — deterministic
    // but useless. Most-played-among-equally-loved is the answer someone
    // actually wants. The title remains the final tie-break so the order is
    // still stable when hours tie too.
    const byHours = (b.row.hoursTenths ?? 0) - (a.row.hoursTenths ?? 0);
    if (byHours !== 0) return byHours;

    return a.row.title.localeCompare(b.row.title);
  });

  return scored.slice(0, limit).map(({ row, value }) => ({
    id: row.id,
    title: row.title,
    coverUrl: row.coverUrl,
    platform: row.platform,
    value,
  }));
}
