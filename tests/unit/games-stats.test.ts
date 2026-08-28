import { describe, expect, it } from 'vitest';

import { countableGames } from '@/server/games/collections';
import {
  type DistributionSlice,
  type GameStatRow,
  buildDistribution,
  buildLeaderboard,
  buildFinancialSummary,
  buildGenreDistribution,
  buildLibrarySummary,
  buildYearlyBreakdown,
  capDistributionSlices,
  findCallouts,
  splitGenres,
} from '@/server/games/stats';

function game(overrides: Partial<GameStatRow>): GameStatRow {
  return {
    id: 'game-1',
    title: 'Elden Ring',
    platform: 'ps5',
    ownership: 'physical',
    developer: 'FromSoftware, Inc.',
    publisher: 'Bandai Namco Entertainment',
    genre: 'Action RPG',
    coverUrl: null,
    status: 'played',
    rating: 5,
    hoursTenths: 1360,
    firstPlayedYear: 2022,
    achievementsUnlocked: 42,
    achievementsTotal: 42,
    platinum: false,
    metacritic: null,
    priceCents: 5999,
    collectionId: null,
    ...overrides,
  };
}

describe('buildYearlyBreakdown', () => {
  it('groups games, hours, and achievements by year, newest first', () => {
    const { rows } = buildYearlyBreakdown(
      [
        game({ id: 'a', firstPlayedYear: 2022, hoursTenths: 100, achievementsUnlocked: 5 }),
        game({ id: 'b', firstPlayedYear: 2023, hoursTenths: 200, achievementsUnlocked: 7 }),
        game({ id: 'c', firstPlayedYear: 2023, hoursTenths: 50, achievementsUnlocked: 1 }),
      ],
      [],
    );

    expect(rows.map((r) => r.year)).toEqual([2023, 2022]);
    expect(rows[0]).toMatchObject({ year: 2023, startedCount: 2, playedCount: 2, hoursTenths: 250, achievements: 8 });
    expect(rows[1]).toMatchObject({ year: 2022, startedCount: 1, playedCount: 1, hoursTenths: 100, achievements: 5 });
  });

  it('excludes a game with no first-played year', () => {
    const { rows } = buildYearlyBreakdown([game({ firstPlayedYear: null })], []);
    expect(rows).toEqual([]);
  });

  it('treats null hours and null achievements as zero', () => {
    const { rows } = buildYearlyBreakdown(
      [game({ firstPlayedYear: 2020, hoursTenths: null, achievementsUnlocked: null })],
      [],
    );
    expect(rows[0]).toMatchObject({ year: 2020, hoursTenths: 0, achievements: 0 });
  });

  it('reports hours in the year they were played, not the year the game started', () => {
    // The bug this whole feature exists to fix: 37h in 2024, 12h in 2025.
    const { rows } = buildYearlyBreakdown(
      [game({ id: 'hk', firstPlayedYear: 2024, hoursTenths: 490, achievementsUnlocked: 3 })],
      [
        { gameId: 'hk', year: 2024, hoursTenths: 370 },
        { gameId: 'hk', year: 2025, hoursTenths: 120 },
      ],
    );

    expect(rows.map((r) => [r.year, r.hoursTenths])).toEqual([
      [2025, 120],
      [2024, 370],
    ]);
  });

  it('counts a split game as started once but played in every year it touched', () => {
    const { rows } = buildYearlyBreakdown(
      [game({ id: 'hk', firstPlayedYear: 2024, hoursTenths: 490 })],
      [
        { gameId: 'hk', year: 2024, hoursTenths: 370 },
        { gameId: 'hk', year: 2025, hoursTenths: 120 },
      ],
    );

    const byYear = new Map(rows.map((r) => [r.year, r]));
    expect(byYear.get(2024)).toMatchObject({ startedCount: 1, playedCount: 1 });
    expect(byYear.get(2025)).toMatchObject({ startedCount: 0, playedCount: 1 });
  });

  it('keeps achievements on the start year even when hours are split', () => {
    const { rows } = buildYearlyBreakdown(
      [game({ id: 'hk', firstPlayedYear: 2024, hoursTenths: 490, achievementsUnlocked: 9 })],
      [
        { gameId: 'hk', year: 2024, hoursTenths: 370 },
        { gameId: 'hk', year: 2025, hoursTenths: 120 },
      ],
    );

    const byYear = new Map(rows.map((r) => [r.year, r]));
    expect(byYear.get(2024)?.achievements).toBe(9);
    expect(byYear.get(2025)?.achievements).toBe(0);
  });

  it('surfaces hours a split fails to account for', () => {
    const { unattributedTenths } = buildYearlyBreakdown(
      [game({ id: 'hk', firstPlayedYear: 2024, hoursTenths: 510 })],
      [{ gameId: 'hk', year: 2024, hoursTenths: 490 }],
    );

    expect(unattributedTenths).toBe(20);
  });

  it('computes the year-over-year change from attributed hours', () => {
    const { rows } = buildYearlyBreakdown(
      [
        game({ id: 'a', firstPlayedYear: 2022, hoursTenths: 100 }),
        game({ id: 'b', firstPlayedYear: 2023, hoursTenths: 250 }),
      ],
      [],
    );

    const byYear = new Map(rows.map((r) => [r.year, r]));
    expect(byYear.get(2022)?.hoursChangeTenths).toBeNull();
    expect(byYear.get(2023)?.hoursChangeTenths).toBe(150);
  });
});

describe('buildLibrarySummary', () => {
  it('counts totals across the whole library regardless of year', () => {
    const summary = buildLibrarySummary([
      game({ id: 'a', status: 'played', hoursTenths: 500, rating: 5 }),
      game({ id: 'b', status: 'backlog', hoursTenths: null, rating: null }),
      game({ id: 'c', status: 'playing', hoursTenths: 100, rating: 3 }),
    ]);

    expect(summary.totalGames).toBe(3);
    expect(summary.totalHoursTenths).toBe(600);
    expect(summary.backlogCount).toBe(1);
    expect(summary.playingCount).toBe(1);
    expect(summary.playedCount).toBe(1);
  });

  it('averages rating over rated games only, ignoring unrated ones', () => {
    const summary = buildLibrarySummary([
      game({ id: 'a', rating: 5 }),
      game({ id: 'b', rating: 3 }),
      game({ id: 'c', rating: null }),
    ]);
    expect(summary.averageRating).toBe(4);
  });

  it('has no average rating at all when nothing is rated', () => {
    expect(buildLibrarySummary([game({ rating: null })]).averageRating).toBeNull();
  });

  // `completionRatePercent` was deleted: with `completed`/`paused_dropped`
  // gone from the status model, `completed / (completed + paused_dropped)`
  // has no definition any more, and the old figure was already misleading —
  // it pinned to 100% whenever nothing was marked dropped, regardless of
  // backlog size. `LibrarySummary` no longer carries the field at all.
  it('does not carry a completion rate field any more', () => {
    const summary = buildLibrarySummary([game({ status: 'played' }), game({ status: 'backlog' })]);
    expect(summary).not.toHaveProperty('completionRatePercent');
  });

  it('counts platinums by the owner-set flag, not by achievement completion', () => {
    const summary = buildLibrarySummary([
      game({ id: 'a', platinum: true }),
      game({ id: 'b', platinum: true }),
      // Full clear, but never flagged platinum — Steam has no platinum
      // equivalent, so this must NOT be inferred from achievement counts.
      game({ id: 'c', platinum: false, achievementsUnlocked: 30, achievementsTotal: 30 }),
    ]);
    expect(summary.platinumCount).toBe(2);
  });

  it('has zero platinums, not null, for an empty or platinum-free library', () => {
    expect(buildLibrarySummary([]).platinumCount).toBe(0);
    expect(buildLibrarySummary([game({ platinum: false })]).platinumCount).toBe(0);
  });

  it('averages hours over games that HAVE logged hours, excluding unlogged ones rather than counting them as zero', () => {
    const summary = buildLibrarySummary([
      game({ id: 'a', hoursTenths: 1000 }),
      game({ id: 'b', hoursTenths: 500 }),
      game({ id: 'c', hoursTenths: null }),
    ]);
    // (1000 + 500) / 2 — the unlogged game does not deflate the mean.
    expect(summary.averageHoursTenthsPerGame).toBe(750);
  });

  it('has no average hours per game when nothing has hours logged, rather than NaN', () => {
    const summary = buildLibrarySummary([game({ hoursTenths: null })]);
    expect(summary.averageHoursTenthsPerGame).toBeNull();
    expect(Number.isNaN(summary.averageHoursTenthsPerGame)).toBe(false);
  });

  it('averages Metacritic over games that have one, excluding the rest', () => {
    const summary = buildLibrarySummary([
      game({ id: 'a', metacritic: 90 }),
      game({ id: 'b', metacritic: 70 }),
      game({ id: 'c', metacritic: null }),
    ]);
    expect(summary.averageMetacritic).toBe(80);
  });

  it('has no average Metacritic when nothing has one, rather than NaN', () => {
    expect(buildLibrarySummary([game({ metacritic: null })]).averageMetacritic).toBeNull();
  });

  it('has no averages at all for an empty library, and no divide-by-zero NaN anywhere', () => {
    const summary = buildLibrarySummary([]);
    expect(summary.totalGames).toBe(0);
    expect(summary.averageRating).toBeNull();
    expect(summary.averageHoursTenthsPerGame).toBeNull();
    expect(summary.averageMetacritic).toBeNull();
    for (const value of Object.values(summary)) {
      expect(typeof value === 'number' ? Number.isNaN(value) : false).toBe(false);
    }
  });
});

describe('buildFinancialSummary', () => {
  it('sums price only across games that have one recorded', () => {
    const financial = buildFinancialSummary([
      game({ id: 'a', priceCents: 5999 }),
      game({ id: 'b', priceCents: 2999 }),
      game({ id: 'c', priceCents: null }),
    ]);
    expect(financial.totalSpendCents).toBe(8998);
  });

  it('averages price over games that have one, excluding games with no price recorded', () => {
    const financial = buildFinancialSummary([
      game({ id: 'a', priceCents: 6000 }),
      game({ id: 'b', priceCents: 4000 }),
      game({ id: 'c', priceCents: null }),
    ]);
    // (6000 + 4000) / 2 — the priceless game does not pull the average toward zero.
    expect(financial.averagePriceCents).toBe(5000);
  });

  it('has no average price for a library where nothing has a price recorded', () => {
    expect(buildFinancialSummary([game({ priceCents: null })]).averagePriceCents).toBeNull();
  });

  it('computes cost per hour as total spend divided by WHOLE hours, not tenths', () => {
    // $60 spent, 10 hours played (100 tenths) -> $6/hour, not $0.60.
    const financial = buildFinancialSummary([game({ priceCents: 6000, hoursTenths: 100 })]);
    expect(financial.costPerHourCents).toBe(600);
  });

  it('has no cost per hour when nothing has any hours logged, rather than a divide-by-zero NaN or Infinity', () => {
    const financial = buildFinancialSummary([game({ priceCents: 6000, hoursTenths: null })]);
    expect(financial.costPerHourCents).toBeNull();
  });

  it('reports backlog count and the money sitting unplayed in it, separately from the rest of the library', () => {
    const financial = buildFinancialSummary([
      game({ id: 'a', status: 'backlog', priceCents: 3000 }),
      game({ id: 'b', status: 'backlog', priceCents: 2000 }),
      game({ id: 'c', status: 'played', priceCents: 9999 }),
    ]);
    expect(financial.backlogCount).toBe(2);
    expect(financial.backlogValueCents).toBe(5000);
  });

  it('has zero totals, not null or NaN, for an empty library', () => {
    const financial = buildFinancialSummary([]);
    expect(financial.totalSpendCents).toBe(0);
    expect(financial.backlogCount).toBe(0);
    expect(financial.backlogValueCents).toBe(0);
    expect(financial.averagePriceCents).toBeNull();
    expect(financial.costPerHourCents).toBeNull();
  });
});

describe('buildDistribution', () => {
  it('counts by key, largest first, and labels each slice', () => {
    const slices = buildDistribution(
      [game({ id: 'a', platform: 'ps5' }), game({ id: 'b', platform: 'ps5' }), game({ id: 'c', platform: 'steam' })],
      (g) => g.platform,
      (key) => key.toUpperCase(),
    );

    expect(slices).toEqual([
      { key: 'ps5', label: 'PS5', count: 2, percent: (2 / 3) * 100 },
      { key: 'steam', label: 'STEAM', count: 1, percent: (1 / 3) * 100 },
    ]);
  });

  it('skips rows whose key is null instead of inventing an "unknown" bucket', () => {
    expect(buildDistribution([game({ genre: null })], (g) => g.genre, (k) => k)).toEqual([]);
  });
});

/**
 * `games.genre` is a single comma-joined `text` column (`joinGenres`,
 * `metadata.ts`) — this is the fix for the worst offender the stats page
 * had: without splitting, `"Shooter, Adventure"` and `"Adventure"` render as
 * two unrelated bars, and a 180-game library produces dozens of one-off
 * genre COMBINATIONS instead of a real per-genre count.
 */
describe('splitGenres', () => {
  it('splits a comma-joined genre string, trimming each part', () => {
    expect(splitGenres('Shooter, Adventure')).toEqual(['Shooter', 'Adventure']);
  });

  it('handles inconsistent whitespace around the comma', () => {
    expect(splitGenres('Shooter ,  Adventure ,RPG')).toEqual(['Shooter', 'Adventure', 'RPG']);
  });

  it('returns a single-element array for a game with one genre', () => {
    expect(splitGenres('Adventure')).toEqual(['Adventure']);
  });

  it('drops empty segments from a stray leading, trailing, or doubled comma', () => {
    expect(splitGenres(',Shooter,, Adventure,')).toEqual(['Shooter', 'Adventure']);
  });

  it('excludes a null genre entirely rather than returning an "Unknown" bucket', () => {
    expect(splitGenres(null)).toEqual([]);
  });

  it('returns nothing for a blank or whitespace-only genre', () => {
    expect(splitGenres('')).toEqual([]);
    expect(splitGenres('   ')).toEqual([]);
  });
});

describe('buildGenreDistribution', () => {
  it('counts a multi-genre game once per individual genre, not once per combination', () => {
    const slices = buildGenreDistribution([
      game({ id: 'a', genre: 'Shooter, Adventure' }),
      game({ id: 'b', genre: 'Adventure' }),
    ]);

    const byLabel = new Map(slices.map((s) => [s.label, s.count]));
    expect(byLabel.get('Shooter')).toBe(1);
    // Two DISTINCT source strings ("Shooter, Adventure" and "Adventure")
    // both count toward the same "Adventure" bucket — the exact merge the
    // old exact-string bucketing failed to do.
    expect(byLabel.get('Adventure')).toBe(2);
    expect(slices).toHaveLength(2);
  });

  it('excludes a game with no genre recorded rather than bucketing it as "Unknown"', () => {
    const slices = buildGenreDistribution([game({ genre: null }), game({ id: 'b', genre: 'Adventure' })]);
    expect(slices).toEqual([{ key: 'Adventure', label: 'Adventure', count: 1, percent: 100 }]);
  });

  it('returns nothing for a library with no genres recorded at all', () => {
    expect(buildGenreDistribution([game({ genre: null })])).toEqual([]);
  });

  it('caps at the top 8 genres plus one "Other" bucket for a long tail', () => {
    // 12 distinct genres, one game each except "Action" (5 games) so the
    // ranking is unambiguous: Action first, then 8 more real genres, with
    // the remaining 3 folded into "Other".
    const rows = [
      ...Array.from({ length: 5 }, (_unused, i) => game({ id: `action-${i}`, genre: 'Action' })),
      game({ id: 'g2', genre: 'Adventure' }),
      game({ id: 'g3', genre: 'RPG' }),
      game({ id: 'g4', genre: 'Shooter' }),
      game({ id: 'g5', genre: 'Platformer' }),
      game({ id: 'g6', genre: 'Puzzle' }),
      game({ id: 'g7', genre: 'Racing' }),
      game({ id: 'g8', genre: 'Simulation' }),
      game({ id: 'g9', genre: 'Strategy' }),
      game({ id: 'g10', genre: 'Fighting' }),
      game({ id: 'g11', genre: 'Sports' }),
      game({ id: 'g12', genre: 'Rhythm' }),
    ];

    const slices = buildGenreDistribution(rows);

    expect(slices).toHaveLength(9); // top 8 + Other
    expect(slices[0]).toMatchObject({ label: 'Action', count: 5 });
    const other = slices.find((s) => s.label === 'Other');
    expect(other).toBeDefined();
    // 12 distinct genres total, top 8 kept individually -> 4 folded into Other.
    expect(other?.count).toBe(4);
    // The capped list must still add up to the same total as the input.
    expect(slices.reduce((sum, s) => sum + s.count, 0)).toBe(16);
  });
});

describe('capDistributionSlices', () => {
  function slice(key: string, count: number): DistributionSlice {
    return { key, label: key, count, percent: count };
  }

  it('leaves a list at or under the limit unchanged', () => {
    const slices = [slice('a', 3), slice('b', 2)];
    expect(capDistributionSlices(slices, 5)).toEqual(slices);
  });

  it('folds everything past the limit into one "Other" bucket, preserving totals', () => {
    const slices = [slice('a', 10), slice('b', 8), slice('c', 5), slice('d', 3), slice('e', 1)];
    const capped = capDistributionSlices(slices, 2);

    expect(capped).toEqual([
      { key: 'a', label: 'a', count: 10, percent: 10 },
      { key: 'b', label: 'b', count: 8, percent: 8 },
      { key: '__other__', label: 'Other', count: 9, percent: 9 },
    ]);
  });

  it('is a no-op on an empty list', () => {
    expect(capDistributionSlices([], 8)).toEqual([]);
  });
});

describe('findCallouts', () => {
  it('finds the most-played developer by summed hours, not by game count', () => {
    // Two short FromSoftware games vs one very long Rockstar game.
    const callouts = findCallouts(
      [
        game({ id: 'a', developer: 'FromSoftware, Inc.', hoursTenths: 100 }),
        game({ id: 'b', developer: 'FromSoftware, Inc.', hoursTenths: 100 }),
        game({ id: 'c', developer: 'Rockstar Games', hoursTenths: 1700 }),
      ],
      [],
    );
    expect(callouts.topDeveloper?.name).toBe('Rockstar Games');
    expect(callouts.topDeveloper?.hoursTenths).toBe(1700);
  });

  /**
   * `bestYear` no longer derives its own year->hours map from `firstPlayedYear`
   * — it picks the max out of the already-computed `YearlyBreakdownRow[]`, the
   * same rows `buildYearlyBreakdown` hands the Year-by-year table. Building
   * `yearlyRows` via the real function here (rather than a hand-written
   * fixture) is what actually proves the two agree.
   */
  it('finds the best year from the already-computed yearly breakdown', () => {
    const rows = [
      game({ id: 'a', firstPlayedYear: 2022, hoursTenths: 4640 }),
      game({ id: 'b', firstPlayedYear: 2023, hoursTenths: 4380 }),
    ];
    const { rows: yearlyRows } = buildYearlyBreakdown(rows, []);

    const callouts = findCallouts(rows, yearlyRows);
    expect(callouts.bestYear?.year).toBe(2022);
    expect(callouts.bestYear?.hoursTenths).toBe(4640);
  });

  /**
   * Regression for the bug the Task 4 review caught: this callout used to
   * credit a split game's FULL total to its `firstPlayedYear`, disagreeing
   * with the Year-by-year table (built from `attributeHours`) for the exact
   * same library — the card said "2024, 591.7h" while the table said "2024,
   * 579.7h". With `bestYear` now reading off the SAME breakdown rows the
   * table renders, a play-year split moves this callout's numbers exactly
   * the way it moves the table's.
   */
  it('reflects a play-year split rather than crediting the full total to the start year', () => {
    const rows = [
      game({ id: 'hk', firstPlayedYear: 2024, hoursTenths: 490 }),
      game({ id: 'other', firstPlayedYear: 2023, hoursTenths: 400 }),
    ];
    const playYears = [
      { gameId: 'hk', year: 2024, hoursTenths: 370 },
      { gameId: 'hk', year: 2025, hoursTenths: 120 },
    ];
    const { rows: yearlyRows } = buildYearlyBreakdown(rows, playYears);

    const callouts = findCallouts(rows, yearlyRows);
    // 2024 now holds only 370h once the split is applied, so 2023's flat
    // 400h wins — the bug this test guards against would have said 2024/490h.
    expect(callouts.bestYear).toEqual({ year: 2023, hoursTenths: 400 });
  });

  it('returns nulls rather than throwing on an empty library', () => {
    const callouts = findCallouts([], []);
    expect(callouts.topDeveloper).toBeNull();
    expect(callouts.bestYear).toBeNull();
  });
});

/**
 * `buildLeaderboard` powers the Top 3 panels. Its load-bearing property is
 * EXCLUSION: a game with no value for a metric must be left out, never ranked
 * as a zero. An unrated game is not a one-star game.
 */
describe('buildLeaderboard', () => {
  it('ranks by hours, highest first', () => {
    const top = buildLeaderboard(
      [
        game({ id: 'a', title: 'Short', hoursTenths: 100 }),
        game({ id: 'b', title: 'Long', hoursTenths: 1700 }),
        game({ id: 'c', title: 'Middling', hoursTenths: 600 }),
      ],
      'hours',
      3,
    );
    expect(top.map((e) => e.title)).toEqual(['Long', 'Middling', 'Short']);
  });

  it('honours the limit', () => {
    const rows = [1, 2, 3, 4, 5].map((n) => game({ id: `g${n}`, title: `G${n}`, hoursTenths: n * 100 }));
    expect(buildLeaderboard(rows, 'hours', 3)).toHaveLength(3);
  });

  it('excludes unplayed games from the hours board rather than ranking them zero', () => {
    const top = buildLeaderboard(
      [game({ id: 'a', title: 'Played', hoursTenths: 100 }), game({ id: 'b', title: 'Never', hoursTenths: 0 })],
      'hours',
      3,
    );
    expect(top.map((e) => e.title)).toEqual(['Played']);
  });

  it('excludes unrated games from the rating board rather than treating null as zero', () => {
    const top = buildLeaderboard(
      [game({ id: 'a', title: 'Rated', rating: 4 }), game({ id: 'b', title: 'Unrated', rating: null })],
      'rating',
      3,
    );
    expect(top.map((e) => e.title)).toEqual(['Rated']);
  });

  it('excludes games with no trophies earned', () => {
    const top = buildLeaderboard(
      [
        game({ id: 'a', title: 'Some', achievementsUnlocked: 12 }),
        game({ id: 'b', title: 'None', achievementsUnlocked: 0 }),
        game({ id: 'c', title: 'Unknown', achievementsUnlocked: null }),
      ],
      'trophies',
      3,
    );
    expect(top.map((e) => e.title)).toEqual(['Some']);
  });

  it('ranks cost per hour LOWEST first, because cheap per hour is the good end', () => {
    // $60 over 60h = 100 cents/h; $20 over 40h = 50 cents/h.
    const top = buildLeaderboard(
      [
        game({ id: 'a', title: 'Pricey', priceCents: 6000, hoursTenths: 600 }),
        game({ id: 'b', title: 'Bargain', priceCents: 2000, hoursTenths: 400 }),
      ],
      'costPerHour',
      3,
    );
    expect(top.map((e) => [e.title, e.value])).toEqual([
      ['Bargain', 50],
      ['Pricey', 100],
    ]);
  });

  it('excludes a free game from the value board rather than calling it infinitely good', () => {
    const top = buildLeaderboard(
      [
        game({ id: 'a', title: 'Free', priceCents: 0, hoursTenths: 600 }),
        game({ id: 'b', title: 'Paid', priceCents: 2000, hoursTenths: 400 }),
      ],
      'costPerHour',
      3,
    );
    expect(top.map((e) => e.title)).toEqual(['Paid']);
  });

  it('excludes an unplayed game from the value board rather than dividing by zero', () => {
    const top = buildLeaderboard([game({ id: 'a', title: 'Shelf', priceCents: 6000, hoursTenths: 0 })], 'costPerHour', 3);
    expect(top).toEqual([]);
  });

  it('breaks a rating tie on hours played, not the alphabet', () => {
    // A 160-game library has dozens of 5-star entries; alphabetical would
    // render "your favourites" as "the 5-star games nearest A".
    const top = buildLeaderboard(
      [
        game({ id: 'a', title: 'Zebra', rating: 5, hoursTenths: 9000 }),
        game({ id: 'b', title: 'Alpha', rating: 5, hoursTenths: 10 }),
      ],
      'rating',
      3,
    );
    expect(top.map((e) => e.title)).toEqual(['Zebra', 'Alpha']);
  });

  it('falls back to the alphabet when the metric AND hours both tie', () => {
    const top = buildLeaderboard(
      [game({ id: 'a', title: 'Zebra', hoursTenths: 500 }), game({ id: 'b', title: 'Alpha', hoursTenths: 500 })],
      'hours',
      3,
    );
    expect(top.map((e) => e.title)).toEqual(['Alpha', 'Zebra']);
  });

  it('carries the cover and platform through for rendering', () => {
    const top = buildLeaderboard(
      [game({ id: 'a', title: 'X', hoursTenths: 100, coverUrl: 'https://example.invalid/x.jpg', platform: 'ps4' })],
      'hours',
      3,
    );
    expect(top[0]).toMatchObject({ id: 'a', coverUrl: 'https://example.invalid/x.jpg', platform: 'ps4' });
  });

  it('returns an empty board for an empty library', () => {
    expect(buildLeaderboard([], 'hours', 3)).toEqual([]);
  });
});

/**
 * Collections — a bundle bought once, holding several games counted
 * separately. Modelled on the owner's real data: "Uncharted: The Nathan
 * Drake Collection" is one PS4 purchase (£22.90, 44h, 154 trophies, one
 * platinum) containing three distinct games.
 *
 * The rule under test, from `countableGames`: anything that counts GAMES
 * excludes the collection wrapper; anything that sums HOURS, MONEY or
 * TROPHIES includes everything.
 */
describe('collections', () => {
  const COLLECTION_ID = 'nathan-drake-collection';

  /** The wrapper: carries the money, the hours and the trophies. */
  const collection = (overrides: Partial<GameStatRow> = {}): GameStatRow =>
    game({
      id: COLLECTION_ID,
      title: 'Uncharted: The Nathan Drake Collection',
      platform: 'ps4',
      hoursTenths: 440,
      priceCents: 2290,
      achievementsUnlocked: 154,
      achievementsTotal: 154,
      platinum: true,
      firstPlayedYear: 2024,
      rating: 2,
      genre: 'Action-Adventure',
      collectionId: null,
      ...overrides,
    });

  /** A title inside it: a real game, but carrying no hours, price or trophies of its own. */
  const member = (id: string, title: string, overrides: Partial<GameStatRow> = {}): GameStatRow =>
    game({
      id,
      title,
      platform: 'ps4',
      hoursTenths: null,
      priceCents: null,
      achievementsUnlocked: null,
      achievementsTotal: null,
      platinum: false,
      rating: null,
      ownership: null,
      firstPlayedYear: 2024,
      genre: 'Action-Adventure',
      collectionId: COLLECTION_ID,
      ...overrides,
    });

  const library = (): GameStatRow[] => [
    collection(),
    member('drakes-fortune', "Uncharted: Drake's Fortune Remastered"),
    member('among-thieves', 'Uncharted 2: Among Thieves Remastered'),
    member('drakes-deception', "Uncharted 3: Drake's Deception Remastered"),
    game({ id: 'elden-ring', title: 'Elden Ring', hoursTenths: 1360, priceCents: 5999, firstPlayedYear: 2022 }),
  ];

  it('counts the titles inside a collection but not the collection itself', () => {
    const countable = countableGames(library());

    expect(countable.map((row) => row.id)).toEqual([
      'drakes-fortune',
      'among-thieves',
      'drakes-deception',
      'elden-ring',
    ]);
    expect(countable.map((row) => row.id)).not.toContain(COLLECTION_ID);
  });

  it('treats a row nobody points at as an ordinary game, not a collection', () => {
    const rows = [game({ id: 'solo' })];
    expect(countableGames(rows).map((row) => row.id)).toEqual(['solo']);
  });

  it('reports four games for three titles plus a standalone, never five', () => {
    // The bug this exists to prevent: counting the wrapper alongside its own
    // contents reports one more game than the owner actually has.
    expect(buildLibrarySummary(library()).totalGames).toBe(4);
  });

  it("counts a collection's hours and trophies exactly once, on the collection", () => {
    const summary = buildLibrarySummary(library());

    // 44h from the collection + 136h from Elden Ring. The three titles carry
    // null hours, so they contribute nothing and cannot double-count.
    expect(summary.totalHoursTenths).toBe(440 + 1360);
    expect(summary.platinumCount).toBe(1);
  });

  it('excludes the collection from status counts, so a backlog of titles is not inflated by its wrapper', () => {
    const rows = [
      collection({ status: 'backlog' }),
      member('a', 'A', { status: 'backlog' }),
      member('b', 'B', { status: 'backlog' }),
    ];

    // Two games are waiting, not three — the collection is not itself
    // something you sit down and play.
    expect(buildLibrarySummary(rows).backlogCount).toBe(2);
  });

  it('counts backlog TITLES but sums backlog MONEY from the collection that holds it', () => {
    const rows = [
      collection({ status: 'backlog' }),
      member('a', 'A', { status: 'backlog' }),
      member('b', 'B', { status: 'backlog' }),
    ];
    const financial = buildFinancialSummary(rows);

    expect(financial.backlogCount).toBe(2);
    // The price lives on the collection, and is real money sitting unplayed.
    expect(financial.backlogValueCents).toBe(2290);
  });

  it('counts a collection once toward total spend, not once per title inside it', () => {
    expect(buildFinancialSummary(library()).totalSpendCents).toBe(2290 + 5999);
  });

  it('credits a year with the titles started, and with the collection’s trophies and hours', () => {
    const { rows } = buildYearlyBreakdown(library(), []);
    const twentyFour = rows.find((row) => row.year === 2024);

    // Three titles started in 2024 — the wrapper is not a fourth.
    expect(twentyFour?.startedCount).toBe(3);
    // ...but the trophies and hours it carries are the real ones.
    expect(twentyFour?.achievements).toBe(154);
    expect(twentyFour?.hoursTenths).toBe(440);
  });

  it('does not count a collection as a platform of its own in a distribution', () => {
    // Four PS4 rows exist, but only three are games. Counting the wrapper
    // would report a fourth PS4 entry that nobody owns.
    const platforms = buildDistribution(
      countableGames(library()),
      (row) => row.platform,
      (key) => key,
    );

    expect(platforms.find((slice) => slice.key === 'ps4')?.count).toBe(3);
  });

  it('leaves every number unchanged for a library with no collections at all', () => {
    const flat = [
      game({ id: 'a', hoursTenths: 100, priceCents: 1000, firstPlayedYear: 2024 }),
      game({ id: 'b', hoursTenths: 200, priceCents: 2000, firstPlayedYear: 2024 }),
    ];
    const summary = buildLibrarySummary(flat);

    expect(summary.totalGames).toBe(2);
    expect(summary.totalHoursTenths).toBe(300);
    expect(buildFinancialSummary(flat).totalSpendCents).toBe(3000);
  });
});
