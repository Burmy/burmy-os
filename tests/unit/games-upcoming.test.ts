import { describe, expect, it } from 'vitest';

import { groupByMonth, toUpcomingGames, type UpcomingGame } from '@/server/games/upcoming';

describe('toUpcomingGames', () => {
  it('shapes a well-formed payload', () => {
    const payload = [
      {
        id: 92550,
        name: 'Fable',
        hypes: 402,
        cover: { image_id: 'cobc6d' },
        platforms: [169, 6, 167],
        release_dates: [
          { y: 2027, m: 2, date_format: 0, platform: 6 },
          { y: 2027, m: 2, date_format: 0, platform: 167 },
          { y: 2027, m: 2, date_format: 0, platform: 169 },
        ],
      },
    ];

    const games = toUpcomingGames(payload);

    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({
      igdbId: 92550,
      title: 'Fable',
      hypes: 402,
      coverUrl: 'https://images.igdb.com/igdb/image/upload/t_cover_big_2x/cobc6d.jpg',
    });
    // Platform 169 (Xbox) is in the raw payload but not one of the two this
    // app tracks — it must never surface in `platforms`.
    expect(games[0]?.platforms).toEqual(['pc', 'ps5']);
  });

  it('drops release_dates rows for a platform other than 167/6', () => {
    const payload = [
      {
        id: 1,
        name: 'Some Game',
        hypes: 100,
        release_dates: [
          { y: 2026, m: 11, date_format: 0, platform: 130 }, // Switch — not tracked
          { y: 2026, m: 11, date_format: 0, platform: 167 },
        ],
      },
    ];

    const games = toUpcomingGames(payload);

    expect(games[0]?.releaseDates).toEqual([{ year: 2026, month: 11, dateFormat: 0 }]);
  });

  it('is null-safe on a missing cover, missing hypes, and a missing/empty platforms or release_dates array', () => {
    const payload = [{ id: 2, name: 'No Extras' }];

    const games = toUpcomingGames(payload);

    expect(games[0]).toMatchObject({ igdbId: 2, title: 'No Extras', coverUrl: null, hypes: 0 });
    expect(games[0]?.platforms).toEqual([]);
    expect(games[0]?.releaseDates).toEqual([]);
  });

  it('skips an entry missing a numeric id', () => {
    const games = toUpcomingGames([{ name: 'No Id' }]);
    expect(games).toEqual([]);
  });

  it('skips an entry missing a name', () => {
    const games = toUpcomingGames([{ id: 5 }]);
    expect(games).toEqual([]);
  });

  it('skips a non-object entry in the array without throwing', () => {
    const games = toUpcomingGames([null, 'not an object', 42, { id: 9, name: 'Valid' }]);
    expect(games).toHaveLength(1);
    expect(games[0]?.igdbId).toBe(9);
  });

  it('skips a malformed release_dates row (missing y or date_format) without dropping the game', () => {
    const payload = [
      {
        id: 3,
        name: 'Partial Dates',
        release_dates: [
          { m: 11, date_format: 0, platform: 167 }, // missing y
          { y: 2026, platform: 167 }, // missing date_format
          { y: 2026, m: 11, date_format: 1, platform: 6 }, // well-formed
        ],
      },
    ];

    const games = toUpcomingGames(payload);

    expect(games).toHaveLength(1);
    expect(games[0]?.releaseDates).toEqual([{ year: 2026, month: 11, dateFormat: 1 }]);
  });

  it('returns [] for a non-array payload, e.g. an IGDB error object', () => {
    expect(toUpcomingGames({ message: 'not authorized' })).toEqual([]);
    expect(toUpcomingGames(null)).toEqual([]);
    expect(toUpcomingGames(undefined)).toEqual([]);
    expect(toUpcomingGames('oops')).toEqual([]);
  });
});

/** Builds a minimal UpcomingGame for groupByMonth tests without going through toUpcomingGames. */
function game(overrides: Partial<UpcomingGame> & { readonly igdbId: number; readonly title: string }): UpcomingGame {
  return {
    coverUrl: null,
    hypes: 0,
    platforms: ['ps5'],
    releaseDates: [],
    ...overrides,
  };
}

describe('groupByMonth', () => {
  const NOW = new Date('2026-08-25T00:00:00Z');

  it('buckets a date_format 0/1 release into its real calendar month', () => {
    const g = game({
      igdbId: 1,
      title: 'Exact Month Game',
      releaseDates: [{ year: 2026, month: 11, dateFormat: 0 }],
    });

    const months = groupByMonth([g], NOW);

    expect(months).toHaveLength(1);
    expect(months[0]).toMatchObject({ key: '2026-11', label: 'November 2026' });
    expect(months[0]?.games).toHaveLength(1);
    expect(months[0]?.games[0]).toMatchObject({ igdbId: 1, title: 'Exact Month Game', releaseDate: '2026-11-01' });
  });

  it('routes date_format 2 (year-only) to Later/TBD, ignoring the placeholder month IGDB fills in', () => {
    // Live-observed: a year-only row still carries a non-null `m` (e.g. 12)
    // — that value must never be read as a real month.
    const g = game({ igdbId: 2, title: 'Year Only', releaseDates: [{ year: 2026, month: 12, dateFormat: 2 }] });

    const months = groupByMonth([g], NOW);

    expect(months).toHaveLength(1);
    expect(months[0]).toMatchObject({ key: 'later', label: 'Later / TBD' });
    expect(months[0]?.games[0]).toMatchObject({ igdbId: 2, releaseDate: null });
  });

  it.each([3, 4, 5, 6])('routes date_format %i (quarter) to Later/TBD', (dateFormat) => {
    const g = game({ igdbId: 10 + dateFormat, title: `Quarter ${dateFormat}`, releaseDates: [{ year: 2027, month: 3, dateFormat }] });

    const months = groupByMonth([g], NOW);

    expect(months[0]?.key).toBe('later');
  });

  it('routes date_format 7 (TBD, no month at all) to Later/TBD', () => {
    const g = game({ igdbId: 3, title: 'TBD', releaseDates: [{ year: 2027, month: null, dateFormat: 7 }] });

    const months = groupByMonth([g], NOW);

    expect(months[0]?.key).toBe('later');
  });

  it('rejects a release_dates row earlier than the current calendar month, even though the game otherwise qualifies', () => {
    // Live-observed hazard: IGDB returns release_dates rows in the past
    // (here: April 2026) even when the query is scoped to future-only
    // first_release_date. "now" is August 2026 in this test.
    const g = game({ igdbId: 4, title: 'Stale Row', releaseDates: [{ year: 2026, month: 4, dateFormat: 0 }] });

    const months = groupByMonth([g], NOW);

    // No valid future exact-month row survives -> Later/TBD, not dropped.
    expect(months).toHaveLength(1);
    expect(months[0]?.key).toBe('later');
    expect(months[0]?.games[0]?.igdbId).toBe(4);
  });

  it('accepts a release_dates row in the current calendar month (not "earlier than")', () => {
    const g = game({ igdbId: 5, title: 'This Month', releaseDates: [{ year: 2026, month: 8, dateFormat: 0 }] });

    const months = groupByMonth([g], NOW);

    expect(months[0]).toMatchObject({ key: '2026-08' });
  });

  it('picks the EARLIEST qualifying month and lists all platforms, when a game has several release_dates rows', () => {
    const g = game({
      igdbId: 6,
      title: 'Multi Platform',
      platforms: ['ps5', 'pc'],
      releaseDates: [
        { year: 2027, month: 2, dateFormat: 0 }, // PC, later
        { year: 2026, month: 11, dateFormat: 0 }, // PS5, earlier
      ],
    });

    const months = groupByMonth([g], NOW);

    expect(months).toHaveLength(1);
    expect(months[0]?.key).toBe('2026-11');
    // Appears once, not once per release row, with both platforms listed.
    expect(months[0]?.games).toHaveLength(1);
    expect(months[0]?.games[0]?.platforms).toEqual(['ps5', 'pc']);
  });

  it('orders real months chronologically ascending, with Later/TBD always trailing regardless of hype', () => {
    const nov = game({ igdbId: 1, title: 'November', hypes: 10, releaseDates: [{ year: 2026, month: 11, dateFormat: 0 }] });
    const sep = game({ igdbId: 2, title: 'September', hypes: 999, releaseDates: [{ year: 2026, month: 9, dateFormat: 0 }] });
    const later = game({ igdbId: 3, title: 'Someday', hypes: 500, releaseDates: [{ year: 2026, month: 12, dateFormat: 2 }] });

    const months = groupByMonth([nov, sep, later], NOW);

    expect(months.map((m) => m.key)).toEqual(['2026-09', '2026-11', 'later']);
  });

  it('sorts games within a month by hypes descending', () => {
    const low = game({ igdbId: 1, title: 'Low', hypes: 30, releaseDates: [{ year: 2026, month: 11, dateFormat: 0 }] });
    const high = game({ igdbId: 2, title: 'High', hypes: 900, releaseDates: [{ year: 2026, month: 11, dateFormat: 0 }] });

    const months = groupByMonth([low, high], NOW);

    expect(months[0]?.games.map((g) => g.igdbId)).toEqual([2, 1]);
  });

  it('returns [] for an empty game list', () => {
    expect(groupByMonth([], NOW)).toEqual([]);
  });
});
