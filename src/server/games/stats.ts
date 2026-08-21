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
