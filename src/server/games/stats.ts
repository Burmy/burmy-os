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

import { collectionIdsIn, countableGames } from './collections';
import { type GameDlcRow, gameTotals, groupDlcByGame } from './dlc';
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
  /** The collection this title belongs to. See `collections.ts` for the counting rule this feeds. */
  readonly collectionId: string | null;
}

export interface YearlyBreakdownRow {
  readonly year: number;
  /** Games whose `firstPlayedYear` is this year. Sums to the library total across years. */
  readonly startedCount: number;
  /**
   * Distinct games with hours attributed to this year. Deliberately does NOT
   * sum to the library total: a game played across two years is genuinely
   * played in both, and counting it once would hide that.
   *
   * A collection counts ONCE here, not once per title inside it — hours are
   * attributed to the row that carries them. `startedCount` above is the
   * figure that reflects the owner's own game count; this one answers "what
   * did I have on the go," where the collection is the honest unit.
   *
   * Only a game with HOURS in the year counts (2026-10-25). A row with a year
   * and nothing played is not "on the go": a rolled-up set arrives with null
   * hours beside the members that carry them, and an unsplit set's titles
   * arrive with none beside the set — counting those put The Arkane
   * Collection on top of its own four titles (16 for 15) and five Uncharted
   * titles beside their two sets (19 for 14).
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
  /**
   * The games that belong to NO row — no first-played year and no split —
   * so the table's Total can still equal the library (2026-10-25). Before
   * this they simply vanished: 51 games, 14.8h and 21 trophies short of the
   * cards above the table, with nothing on screen saying why. `games`
   * follows the counting rule (a collection wrapper is not a game); hours
   * and trophies are whatever those rows carry.
   */
  readonly noYear: NoYearTotals;
}

export interface NoYearTotals {
  readonly games: number;
  readonly hoursTenths: number;
  readonly achievements: number;
}

export interface LibrarySummary {
  readonly totalGames: number;
  readonly totalHoursTenths: number;
  readonly playedCount: number;
  /** Mean of rated games only, 1-5. Null when nothing is rated. */
  readonly averageRating: number | null;
  /** Count of games with the owner's own `platinum` flag set. */
  readonly platinumCount: number;
  /**
   * Mean `hoursTenths` over games that HAVE logged hours. Null when nothing
   * has any hours logged — an unplayed backlog entry is excluded, not counted
   * as a zero.
   *
   * APPROXIMATE FOR COLLECTIONS, deliberately: a collection's hours are one
   * figure covering several titles, so its 44h divides by one row here, not
   * three. Reporting it exactly would mean per-title hours, which neither
   * PSN nor Steam can supply and the owner does not record — the same limit
   * `game_play_years` documents for per-year splits. This is the identical
   * approximation the source spreadsheet made, named here rather than
   * silently inherited.
   */
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
  /**
   * The genre with the most hours. A multi-genre game ("Platform, Adventure")
   * credits its full hours to EACH of its genres — the same rule the genre
   * distribution uses for counts — so this is "the genre you spend the most
   * time in", not a partition of the total.
   */
  readonly topGenre: { readonly name: string; readonly hoursTenths: number } | null;
  /** The highest price paid, base + DLC. */
  readonly priciestGame: { readonly title: string; readonly priceCents: number } | null;
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
/**
 * Every row with its hours, price and achievement counts replaced by
 * base + DLC (`gameTotals`). DLC is ADDITIVE — see `dlc.ts` — so this is the
 * only place the stat builders need to know DLC exists: they read the totals
 * exactly as they always read the base figures. A DLC row whose game is not
 * in `rows` contributes nothing (`listGameStatRows` already excludes
 * `wanted` games; their DLC, if any, must not leak into the figures).
 *
 * Applied AFTER `trophyAdjustedRows` (which runs at the database boundary),
 * so a collection's DLC trophies add on top of the member roll-up — by
 * owner decision, one rule throughout: DLC adds to whatever row it is on.
 */
function withDlcTotals(rows: readonly GameStatRow[], dlc: readonly GameDlcRow[]): GameStatRow[] {
  if (dlc.length === 0) return [...rows];
  const byGame = groupDlcByGame(dlc);
  return rows.map((row) => {
    const own = byGame.get(row.id);
    return own === undefined ? row : { ...row, ...gameTotals(row, own) };
  });
}

export function buildYearlyBreakdown(
  rows: readonly GameStatRow[],
  playYears: readonly PlayYearRow[],
  dlc: readonly GameDlcRow[],
): YearlyBreakdown {
  // Attribution works on the BASE hours: a year split apportions the game's
  // own total and must sum to it. DLC hours never enter the split — each DLC
  // is credited to its own year below, on top.
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
    const created = {
      startedCount: 0,
      playedGames: new Set<string>(),
      hoursTenths: 0,
      achievements: 0,
    };
    byYear.set(year, created);
    return created;
  }

  for (const attribution of attributions) {
    const target = bucket(attribution.year);
    target.hoursTenths += attribution.hoursTenths;
    // Trophies ride the same attribution: a split row that says "13 that
    // year" credits 13 there; a game or split that says nothing leaves them
    // all on the first-played year (`attributeHours`).
    target.achievements += attribution.achievementsUnlocked;
    if (attribution.hoursTenths > 0) target.playedGames.add(attribution.gameId);
  }

  // A collection is not itself a game that was started, but an UNSPLIT set's
  // achievements are the real ones (its titles carry none) — a rolled-up set
  // already arrives with null hours and trophies from `collectionAdjustedRows`
  // and its members carry them instead. So this loop walks every row and
  // applies the counting rule to `startedCount` alone. See `countableGames`.
  const collections = collectionIdsIn(rows);
  const splitGameIds = new Set(playYears.map((row) => row.gameId));
  const noYear = { games: 0, hoursTenths: 0, achievements: 0 };

  for (const row of rows) {
    // A retro entry with no year is not year zero — it has no place in a
    // year-by-year comparison and is excluded rather than bucketed. It is
    // still counted in `noYear`, so the table's Total can say where the
    // rest of the library is. A game with no year but a split is placed by
    // its rows (`attributeHours`) and is not "no year".
    if (row.firstPlayedYear === null) {
      if (splitGameIds.has(row.id)) continue;
      if (!collections.has(row.id)) noYear.games += 1;
      noYear.hoursTenths += row.hoursTenths ?? 0;
      noYear.achievements += row.achievementsUnlocked ?? 0;
      continue;
    }
    const target = bucket(row.firstPlayedYear);
    if (!collections.has(row.id)) target.startedCount += 1;
  }

  // A DLC's hours and trophies belong to the year the owner PLAYED it. It is
  // not a game that was started (`startedCount` is untouched), but it is a
  // year the game was genuinely played in, so the game counts toward that
  // year's `playedCount`.
  const gameIds = new Set(rows.map((row) => row.id));
  for (const row of dlc) {
    if (!gameIds.has(row.gameId)) continue;
    const target = bucket(row.year);
    target.hoursTenths += row.hoursTenths ?? 0;
    target.achievements += row.achievementsUnlocked ?? 0;
    if ((row.hoursTenths ?? 0) > 0) target.playedGames.add(row.gameId);
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

  return { rows: built, unattributedTenths, noYear };
}

export function buildLibrarySummary(
  baseRows: readonly GameStatRow[],
  dlc: readonly GameDlcRow[],
): LibrarySummary {
  const rows = withDlcTotals(baseRows, dlc);
  // COUNTS only — see `countableGames`. Every sum and average below stays on
  // the full `rows`, because a collection is where the hours, price and
  // trophies actually live.
  const games = countableGames(rows);

  // A collection has no rating of its own (owner, 2026-10-19): the games
  // inside it are what gets rated, so the average runs over the countable
  // games. A rating left on a wrapper row by an old import is ignored here,
  // not averaged — the UI no longer offers one.
  const rated = games.filter((row) => row.rating !== null);

  // Excluded from their averages entirely, not counted as a zero — the same
  // rule `averageRating` already follows: a game with no hours logged or no
  // Metacritic score is missing data, not a real zero to pull the mean down.
  const withHours = rows.filter((row) => row.hoursTenths !== null);
  const withMetacritic = rows.filter((row) => row.metacritic !== null);

  return {
    totalGames: games.length,
    totalHoursTenths: rows.reduce((total, row) => total + (row.hoursTenths ?? 0), 0),
    playedCount: games.filter((row) => row.status === 'played').length,
    averageRating:
      rated.length === 0
        ? null
        : rated.reduce((sum, row) => sum + (row.rating ?? 0), 0) / rated.length,
    platinumCount: rows.filter((row) => row.platinum).length,
    averageHoursTenthsPerGame:
      withHours.length === 0
        ? null
        : withHours.reduce((sum, row) => sum + (row.hoursTenths ?? 0), 0) / withHours.length,
    averageMetacritic:
      withMetacritic.length === 0
        ? null
        : withMetacritic.reduce((sum, row) => sum + (row.metacritic ?? 0), 0) /
          withMetacritic.length,
  };
}

/**
 * Trophy and achievement totals across the library, from the hand-entered
 * `achievementsUnlocked` / `achievementsTotal` counts on each row — the same
 * numbers the trophies-per-year chart and the "Most trophies" leaderboard
 * read. There is no per-trophy table any more; these two counts ARE the
 * trophy data.
 *
 * Rows arrive through `listGameStatRows`, which has already rolled a
 * collection's members up into the collection row (`trophyAdjustedRows`), so
 * summing the full set counts every trophy exactly once. A row with no count
 * recorded contributes nothing — missing data, not zero — and `total` is
 * `null` when NO row carries one, so a card can say "52 earned" rather than
 * "52 of 0".
 */
export interface TrophyTotals {
  readonly earned: number;
  readonly total: number | null;
  /** Rows with at least one earned trophy recorded. */
  readonly gamesWithTrophies: number;
}

export function buildTrophyTotals(
  baseRows: readonly GameStatRow[],
  dlc: readonly GameDlcRow[],
): TrophyTotals {
  const rows = withDlcTotals(baseRows, dlc);
  let earned = 0;
  let total = 0;
  let hasTotal = false;
  let gamesWithTrophies = 0;

  for (const row of rows) {
    if (row.achievementsUnlocked !== null && row.achievementsUnlocked > 0) {
      earned += row.achievementsUnlocked;
      gamesWithTrophies += 1;
    }
    if (row.achievementsTotal !== null && row.achievementsTotal > 0) {
      total += row.achievementsTotal;
      hasTotal = true;
    }
  }

  return { earned, total: hasTotal ? total : null, gamesWithTrophies };
}

/**
 * Money: what the library cost, what a game costs on average, what an hour of
 * play cost, and how much is sitting unplayed in the backlog. Every average
 * here is over games that HAVE the relevant value, exactly like
 * `buildLibrarySummary`'s `averageRating` — a game with no price recorded is
 * missing data, not a free game.
 */
export function buildFinancialSummary(
  baseRows: readonly GameStatRow[],
  dlc: readonly GameDlcRow[],
): FinancialSummary {
  const rows = withDlcTotals(baseRows, dlc);
  const priced = rows.filter((row) => row.priceCents !== null);
  const totalSpendCents = priced.reduce((sum, row) => sum + (row.priceCents ?? 0), 0);

  // Whole hours, not tenths — "cost per hour" is a dollars-per-hour rate, and
  // dividing by tenths-of-an-hour would silently report a figure ten times
  // too small.
  const totalHours = rows.reduce((sum, row) => sum + (row.hoursTenths ?? 0), 0) / 10;

  return {
    totalSpendCents,
    averagePriceCents: priced.length === 0 ? null : totalSpendCents / priced.length,
    costPerHourCents: totalHours === 0 ? null : totalSpendCents / totalHours,
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
export function capDistributionSlices(
  slices: readonly DistributionSlice[],
  limit: number,
): DistributionSlice[] {
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
export function findCallouts(
  baseRows: readonly GameStatRow[],
  dlc: readonly GameDlcRow[],
  yearlyRows: readonly YearlyBreakdownRow[],
): Callouts {
  const rows = withDlcTotals(baseRows, dlc);
  const played = rows.filter((row) => (row.hoursTenths ?? 0) > 0);

  const developerHours = new Map<string, number>();
  for (const row of played) {
    if (row.developer === null || row.developer === '') continue;
    developerHours.set(
      row.developer,
      (developerHours.get(row.developer) ?? 0) + (row.hoursTenths ?? 0),
    );
  }
  const topDeveloperEntry = [...developerHours.entries()].sort((a, b) => b[1] - a[1])[0];

  const bestYearRow = yearlyRows.reduce<YearlyBreakdownRow | null>(
    (best, row) => (best === null || row.hoursTenths > best.hoursTenths ? row : best),
    null,
  );

  const genreHours = new Map<string, number>();
  for (const row of played) {
    for (const genre of splitGenres(row.genre)) {
      genreHours.set(genre, (genreHours.get(genre) ?? 0) + (row.hoursTenths ?? 0));
    }
  }
  const topGenreEntry = [...genreHours.entries()].sort((a, b) => b[1] - a[1])[0];

  const priciest = rows.reduce<GameStatRow | null>(
    (best, row) =>
      row.priceCents !== null &&
      row.priceCents > 0 &&
      (best === null || row.priceCents > (best.priceCents ?? 0))
        ? row
        : best,
    null,
  );

  return {
    topDeveloper:
      topDeveloperEntry === undefined
        ? null
        : { name: topDeveloperEntry[0], hoursTenths: topDeveloperEntry[1] },
    bestYear:
      bestYearRow === null
        ? null
        : { year: bestYearRow.year, hoursTenths: bestYearRow.hoursTenths },
    topGenre:
      topGenreEntry === undefined
        ? null
        : { name: topGenreEntry[0], hoursTenths: topGenreEntry[1] },
    priciestGame:
      priciest === null ? null : { title: priciest.title, priceCents: priciest.priceCents ?? 0 },
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
  baseRows: readonly GameStatRow[],
  dlc: readonly GameDlcRow[],
  metric: LeaderboardMetric,
  limit: number,
): LeaderboardEntry[] {
  const rows = withDlcTotals(baseRows, dlc);
  const scored: { readonly row: GameStatRow; readonly value: number }[] = [];
  // A collection has no rating of its own — see `buildLibrarySummary`.
  const collections = collectionIdsIn(rows);

  for (const row of rows) {
    const hoursTenths = row.hoursTenths ?? 0;

    if (metric === 'hours') {
      if (hoursTenths <= 0) continue;
      scored.push({ row, value: hoursTenths });
    } else if (metric === 'rating') {
      if (row.rating === null || collections.has(row.id)) continue;
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

// ─────────────────────────────────────────────────────────────────────────────
// This year against last year — the arrows under the headline cards (2026-10-19)
// ─────────────────────────────────────────────────────────────────────────────

/** One year's figures, as the arrows compare them. */
export interface YearFigures {
  readonly year: number;
  /** Games whose first-played year is this year — the year table's own count. */
  readonly started: number;
  /** Hours credited to this year by the year table (splits and DLC included). */
  readonly hoursTenths: number;
  /** Trophies credited to this year by the year table. */
  readonly trophies: number;
  /**
   * Price paid on games first played this year, plus DLC played this year.
   * An APPROXIMATION the owner accepted: a game bought in December and
   * started in January counts as January's, because the purchase date is
   * not recorded — only the first-played year is. A collection's price sits
   * on the set and its members carry none, so a set started this year
   * counts once.
   */
  readonly spendCents: number;
  /**
   * Platinums on games first played this year — the same approximation; the
   * platinum's own date is not recorded either.
   */
  readonly platinums: number;
}

export interface YearComparison {
  readonly current: YearFigures;
  /**
   * The previous CALENDAR year — `year - 1`, not the nearest earlier year
   * with data. Null when the year table has no row for it, and the cards
   * then show no arrow at all rather than comparing against a year that is
   * not the one the label would name.
   */
  readonly previous: YearFigures | null;
}

/**
 * One year's figures. Started, hours and trophies are read from
 * `yearlyRows` (`buildYearlyBreakdown(...).rows`) rather than rebuilt, so
 * the arrows and the year table under them can never disagree.
 */
export function yearFigures(
  rows: readonly GameStatRow[],
  dlc: readonly GameDlcRow[],
  yearlyRows: readonly YearlyBreakdownRow[],
  year: number,
): YearFigures {
  const row = yearlyRows.find((candidate) => candidate.year === year);
  const ids = new Set(rows.map((game) => game.id));
  const startedThisYear = rows.filter((game) => game.firstPlayedYear === year);

  const baseSpend = startedThisYear.reduce((sum, game) => sum + (game.priceCents ?? 0), 0);
  const dlcSpend = dlc
    .filter((pack) => pack.year === year && ids.has(pack.gameId))
    .reduce((sum, pack) => sum + (pack.priceCents ?? 0), 0);

  return {
    year,
    started: row?.startedCount ?? 0,
    hoursTenths: row?.hoursTenths ?? 0,
    trophies: row?.achievements ?? 0,
    spendCents: baseSpend + dlcSpend,
    platinums: startedThisYear.filter((game) => game.platinum).length,
  };
}

/**
 * This year against last year, for every arrow on the dashboard. The only
 * history Games keeps is the year table, so "last year" is the one honest
 * comparison available — the owner asked for it on every card, the way
 * Finance compares a month with the one before (2026-10-19).
 */
export function buildYearComparison(
  rows: readonly GameStatRow[],
  dlc: readonly GameDlcRow[],
  yearlyRows: readonly YearlyBreakdownRow[],
  year: number,
): YearComparison {
  const hasPrevious = yearlyRows.some((row) => row.year === year - 1);
  return {
    current: yearFigures(rows, dlc, yearlyRows, year),
    previous: hasPrevious ? yearFigures(rows, dlc, yearlyRows, year - 1) : null,
  };
}
