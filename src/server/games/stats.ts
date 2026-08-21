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
  readonly gameCount: number;
  readonly hoursTenths: number;
  readonly achievements: number;
  /** Hours vs the previous year present in the data. Null for the earliest year. */
  readonly hoursChangeTenths: number | null;
}

export interface LibrarySummary {
  readonly totalGames: number;
  readonly totalHoursTenths: number;
  readonly backlogCount: number;
  readonly playingCount: number;
  readonly completedCount: number;
  /** Mean of rated games only, 1-5. Null when nothing is rated. */
  readonly averageRating: number | null;
  /** Completed / (completed + paused_dropped), 0-100. Null when nothing has been started. */
  readonly completionRatePercent: number | null;
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
  readonly longestGame: { readonly title: string; readonly hoursTenths: number } | null;
  readonly topDeveloper: { readonly name: string; readonly hoursTenths: number } | null;
  readonly bestYear: { readonly year: number; readonly hoursTenths: number } | null;
}

/**
 * Year → games/hours/achievements, newest first. No `currentYear` parameter —
 * this module has no notion of "today"; a caller that wants to highlight the
 * in-progress year passes it in separately when rendering these rows, not
 * when building them.
 */
export function buildYearlyBreakdown(rows: readonly GameStatRow[]): YearlyBreakdownRow[] {
  const byYear = new Map<number, { gameCount: number; hoursTenths: number; achievements: number }>();

  for (const row of rows) {
    // A retro entry with no year is not year zero — it has no place in a
    // year-by-year comparison and is excluded rather than bucketed.
    if (row.firstPlayedYear === null) continue;

    const bucket = byYear.get(row.firstPlayedYear) ?? { gameCount: 0, hoursTenths: 0, achievements: 0 };
    byYear.set(row.firstPlayedYear, {
      gameCount: bucket.gameCount + 1,
      hoursTenths: bucket.hoursTenths + (row.hoursTenths ?? 0),
      achievements: bucket.achievements + (row.achievementsUnlocked ?? 0),
    });
  }

  const ascending = [...byYear.entries()].sort((a, b) => a[0] - b[0]);

  return ascending
    .map(([year, bucket], index) => {
      const previous = index === 0 ? null : ascending[index - 1]![1];
      return {
        year,
        gameCount: bucket.gameCount,
        hoursTenths: bucket.hoursTenths,
        achievements: bucket.achievements,
        hoursChangeTenths: previous === null ? null : bucket.hoursTenths - previous.hoursTenths,
      };
    })
    .sort((a, b) => b.year - a.year);
}

export function buildLibrarySummary(rows: readonly GameStatRow[]): LibrarySummary {
  const rated = rows.filter((row) => row.rating !== null);
  const completed = rows.filter((row) => row.status === 'completed').length;
  const dropped = rows.filter((row) => row.status === 'paused_dropped').length;
  const started = completed + dropped;

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
    completedCount: completed,
    averageRating:
      rated.length === 0 ? null : rated.reduce((sum, row) => sum + (row.rating ?? 0), 0) / rated.length,
    // Over STARTED games only: a 40-game backlog you never touched should not
    // read as a 5% completion rate.
    completionRatePercent: started === 0 ? null : (completed / started) * 100,
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

export function findCallouts(rows: readonly GameStatRow[]): Callouts {
  const played = rows.filter((row) => (row.hoursTenths ?? 0) > 0);

  const longest = played.reduce<GameStatRow | null>(
    (best, row) => (best === null || (row.hoursTenths ?? 0) > (best.hoursTenths ?? 0) ? row : best),
    null,
  );

  const developerHours = new Map<string, number>();
  for (const row of played) {
    if (row.developer === null || row.developer === '') continue;
    developerHours.set(row.developer, (developerHours.get(row.developer) ?? 0) + (row.hoursTenths ?? 0));
  }
  const topDeveloperEntry = [...developerHours.entries()].sort((a, b) => b[1] - a[1])[0];

  const yearHours = new Map<number, number>();
  for (const row of played) {
    if (row.firstPlayedYear === null) continue;
    yearHours.set(row.firstPlayedYear, (yearHours.get(row.firstPlayedYear) ?? 0) + (row.hoursTenths ?? 0));
  }
  const bestYearEntry = [...yearHours.entries()].sort((a, b) => b[1] - a[1])[0];

  return {
    longestGame: longest === null ? null : { title: longest.title, hoursTenths: longest.hoursTenths ?? 0 },
    topDeveloper:
      topDeveloperEntry === undefined ? null : { name: topDeveloperEntry[0], hoursTenths: topDeveloperEntry[1] },
    bestYear: bestYearEntry === undefined ? null : { year: bestYearEntry[0], hoursTenths: bestYearEntry[1] },
  };
}
