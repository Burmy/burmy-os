import { describe, expect, it } from 'vitest';

import {
  type GameStatRow,
  buildDistribution,
  buildLibrarySummary,
  buildYearlyBreakdown,
  findCallouts,
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
    status: 'completed',
    rating: 5,
    hoursTenths: 1360,
    firstPlayedYear: 2022,
    achievementsUnlocked: 42,
    achievementsTotal: 42,
    platinum: false,
    metacritic: null,
    ...overrides,
  };
}

describe('buildYearlyBreakdown', () => {
  it('groups games, hours, and achievements by year, newest first', () => {
    const rows = buildYearlyBreakdown([
      game({ id: 'a', firstPlayedYear: 2024, hoursTenths: 450, achievementsUnlocked: 45 }),
      game({ id: 'b', firstPlayedYear: 2024, hoursTenths: 230, achievementsUnlocked: 63 }),
      game({ id: 'c', firstPlayedYear: 2025, hoursTenths: 640, achievementsUnlocked: 54 }),
    ]);

    expect(rows.map((r) => r.year)).toEqual([2025, 2024]);
    expect(rows[1]!).toMatchObject({ year: 2024, gameCount: 2, hoursTenths: 680, achievements: 108 });
  });

  it('excludes games with no year — a sparse retro entry is not year zero', () => {
    const rows = buildYearlyBreakdown([game({ firstPlayedYear: null })]);
    expect(rows).toEqual([]);
  });

  it('treats missing hours and achievements as zero rather than skipping the game', () => {
    const rows = buildYearlyBreakdown([game({ firstPlayedYear: 2020, hoursTenths: null, achievementsUnlocked: null })]);
    expect(rows[0]!).toMatchObject({ year: 2020, gameCount: 1, hoursTenths: 0, achievements: 0 });
  });

  it('reports change versus the previous year so the UI never recomputes it', () => {
    const rows = buildYearlyBreakdown([
      game({ id: 'a', firstPlayedYear: 2023, hoursTenths: 1000 }),
      game({ id: 'b', firstPlayedYear: 2024, hoursTenths: 1500 }),
    ]);

    const y2024 = rows.find((r) => r.year === 2024)!;
    expect(y2024.hoursChangeTenths).toBe(500);
    const y2023 = rows.find((r) => r.year === 2023)!;
    expect(y2023.hoursChangeTenths).toBeNull();
  });
});

describe('buildLibrarySummary', () => {
  it('counts totals across the whole library regardless of year', () => {
    const summary = buildLibrarySummary([
      game({ id: 'a', status: 'completed', hoursTenths: 500, rating: 5 }),
      game({ id: 'b', status: 'backlog', hoursTenths: null, rating: null }),
      game({ id: 'c', status: 'paused_dropped', hoursTenths: 100, rating: 3 }),
    ]);

    expect(summary.totalGames).toBe(3);
    expect(summary.totalHoursTenths).toBe(600);
    expect(summary.backlogCount).toBe(1);
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

  it('computes completion rate over STARTED games, excluding the backlog', () => {
    // 2 completed, 1 dropped, 1 never started -> 2/3, not 2/4.
    const summary = buildLibrarySummary([
      game({ id: 'a', status: 'completed' }),
      game({ id: 'b', status: 'completed' }),
      game({ id: 'c', status: 'paused_dropped' }),
      game({ id: 'd', status: 'backlog' }),
    ]);
    expect(summary.completionRatePercent).toBeCloseTo(66.67, 1);
  });

  it('has no completion rate when nothing has been started', () => {
    expect(buildLibrarySummary([game({ status: 'backlog' })]).completionRatePercent).toBeNull();
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

describe('findCallouts', () => {
  it('finds the longest game by hours', () => {
    const callouts = findCallouts([
      game({ id: 'a', title: 'Short', hoursTenths: 100 }),
      game({ id: 'b', title: 'Long', hoursTenths: 1700 }),
    ]);
    expect(callouts.longestGame?.title).toBe('Long');
  });

  it('finds the most-played developer by summed hours, not by game count', () => {
    // Two short FromSoftware games vs one very long Rockstar game.
    const callouts = findCallouts([
      game({ id: 'a', developer: 'FromSoftware, Inc.', hoursTenths: 100 }),
      game({ id: 'b', developer: 'FromSoftware, Inc.', hoursTenths: 100 }),
      game({ id: 'c', developer: 'Rockstar Games', hoursTenths: 1700 }),
    ]);
    expect(callouts.topDeveloper?.name).toBe('Rockstar Games');
    expect(callouts.topDeveloper?.hoursTenths).toBe(1700);
  });

  it('finds the best year by hours played', () => {
    const callouts = findCallouts([
      game({ id: 'a', firstPlayedYear: 2022, hoursTenths: 4640 }),
      game({ id: 'b', firstPlayedYear: 2023, hoursTenths: 4380 }),
    ]);
    expect(callouts.bestYear?.year).toBe(2022);
  });

  it('returns nulls rather than throwing on an empty library', () => {
    const callouts = findCallouts([]);
    expect(callouts.longestGame).toBeNull();
    expect(callouts.topDeveloper).toBeNull();
    expect(callouts.bestYear).toBeNull();
  });
});
