import { describe, expect, it } from 'vitest';

import {
  compareByAiring,
  membersOf,
  seriesCover,
  seriesTotals,
  suggestSeriesTitle,
  type SeriesMemberRow,
} from '@/server/anime/series';

function member(overrides: Partial<SeriesMemberRow> & { readonly id: string }): SeriesMemberRow {
  return {
    seriesId: 's1',
    titleRomaji: overrides.id,
    episodes: 12,
    progress: 12,
    repeatCount: 0,
    durationMinutes: 24,
    season: 'spring',
    seasonYear: 2020,
    coverUrl: null,
    ...overrides,
  };
}

describe('membersOf', () => {
  it('takes only the rows filed under that series', () => {
    const rows = [member({ id: 'a' }), member({ id: 'b', seriesId: 's2' }), member({ id: 'c', seriesId: null })];
    expect(membersOf(rows, 's1').map((row) => row.id)).toEqual(['a']);
  });

  it('returns them in airing order, not insertion order', () => {
    const rows = [
      member({ id: 'third', seasonYear: 2023, season: 'winter' }),
      member({ id: 'first', seasonYear: 2020, season: 'spring' }),
      member({ id: 'second', seasonYear: 2020, season: 'fall' }),
    ];
    expect(membersOf(rows, 's1').map((row) => row.id)).toEqual(['first', 'second', 'third']);
  });
});

describe('compareByAiring', () => {
  it('orders seasons within a year the way they aired', () => {
    const rows = [
      member({ id: 'fall', season: 'fall' }),
      member({ id: 'winter', season: 'winter' }),
      member({ id: 'summer', season: 'summer' }),
      member({ id: 'spring', season: 'spring' }),
    ];
    expect([...rows].sort(compareByAiring).map((row) => row.id)).toEqual(['winter', 'spring', 'summer', 'fall']);
  });

  it('sorts an undated entry LAST, never first', () => {
    // An undated row is usually a hand-added special. Putting it ahead of a
    // dated first season would claim an order the data does not support.
    const rows = [member({ id: 'special', seasonYear: null, season: null }), member({ id: 's1', seasonYear: 2020 })];
    expect([...rows].sort(compareByAiring).map((row) => row.id)).toEqual(['s1', 'special']);
  });
});

describe('seriesTotals', () => {
  it('counts shows, never the series itself', () => {
    expect(seriesTotals([member({ id: 'a' }), member({ id: 'b' })]).showCount).toBe(2);
  });

  it('counts every rewatch, because a rewatch is time actually spent', () => {
    const totals = seriesTotals([member({ id: 'a', episodes: 12, progress: 12, repeatCount: 2 })]);
    expect(totals.episodesWatched).toBe(36);
    expect(totals.minutesWatched).toBe(36 * 24);
  });

  it('reports null minutes when no member has a known episode length', () => {
    // Never a fabricated zero: "we do not know" and "nothing" are different.
    const totals = seriesTotals([member({ id: 'a', durationMinutes: null })]);
    expect(totals.minutesWatched).toBeNull();
    expect(totals.episodesWatched).toBe(12);
  });

  it('sums the members whose length IS known and ignores the rest', () => {
    const totals = seriesTotals([
      member({ id: 'a', episodes: 12, progress: 12, durationMinutes: 24 }),
      member({ id: 'b', episodes: 12, progress: 12, durationMinutes: null }),
    ]);
    expect(totals.minutesWatched).toBe(288);
  });

  it('spans the airing years present, ignoring undated members', () => {
    const totals = seriesTotals([
      member({ id: 'a', seasonYear: 2013 }),
      member({ id: 'b', seasonYear: 2023 }),
      member({ id: 'c', seasonYear: null }),
    ]);
    expect(totals.firstYear).toBe(2013);
    expect(totals.lastYear).toBe(2023);
  });

  it('reports no span at all when nothing is dated', () => {
    const totals = seriesTotals([member({ id: 'a', seasonYear: null })]);
    expect(totals.firstYear).toBeNull();
    expect(totals.lastYear).toBeNull();
  });

  it('is empty, not broken, for a series with no members yet', () => {
    expect(seriesTotals([])).toEqual({
      showCount: 0,
      episodesWatched: 0,
      minutesWatched: null,
      firstYear: null,
      lastYear: null,
    });
  });
});

describe('seriesCover', () => {
  it("prefers the series' own override", () => {
    expect(seriesCover('own.jpg', [member({ id: 'a', coverUrl: 'member.jpg' })])).toBe('own.jpg');
  });

  it('falls back to the earliest-airing member that has art', () => {
    const cover = seriesCover(null, [
      member({ id: 'later', seasonYear: 2023, coverUrl: 'later.jpg' }),
      member({ id: 'first', seasonYear: 2013, coverUrl: 'first.jpg' }),
    ]);
    expect(cover).toBe('first.jpg');
  });

  it('skips an earlier member that has no art rather than returning null', () => {
    const cover = seriesCover(null, [
      member({ id: 'first', seasonYear: 2013, coverUrl: null }),
      member({ id: 'later', seasonYear: 2023, coverUrl: 'later.jpg' }),
    ]);
    expect(cover).toBe('later.jpg');
  });

  it('is null when nothing anywhere has art', () => {
    expect(seriesCover(null, [member({ id: 'a' })])).toBeNull();
  });
});

describe('suggestSeriesTitle', () => {
  it.each([
    ['Attack on Titan Season 3 Part 2', 'Attack on Titan'],
    ['Attack on Titan: Final Season', 'Attack on Titan'],
    ['Mob Psycho 100 II', 'Mob Psycho 100'],
    ['Spy x Family Season 2', 'Spy x Family'],
    ['Vinland Saga Season 2', 'Vinland Saga'],
    ['Kaguya-sama: Love is War - 2nd Season', 'Kaguya-sama: Love is War'],
    ['Overlord III', 'Overlord'],
  ])('strips the ordinal marker from %s', (input, expected) => {
    expect(suggestSeriesTitle(input)).toBe(expected);
  });

  it.each([
    // UNDER-STRIP. Each of these has a trailing token that LOOKS ordinal and
    // is part of the real title; merging two different shows is far worse than
    // leaving two series the owner joins with one click.
    ['Bleach: Thousand-Year Blood War', 'Bleach: Thousand-Year Blood War'],
    ['Cowboy Bebop', 'Cowboy Bebop'],
    ['Neon Genesis Evangelion', 'Neon Genesis Evangelion'],
    ['86 Eighty-Six', '86 Eighty-Six'],
  ])('leaves %s alone', (input, expected) => {
    expect(suggestSeriesTitle(input)).toBe(expected);
  });

  it('never returns an empty string, however ordinal the whole title is', () => {
    // "Season 2" as an entire title is nonsense, but emptying the field would
    // be worse than keeping it — a series must always have a name.
    expect(suggestSeriesTitle('Season 2')).not.toBe('');
  });

  it('is idempotent — running it on its own output changes nothing', () => {
    const once = suggestSeriesTitle('Attack on Titan Season 3 Part 2');
    expect(suggestSeriesTitle(once)).toBe(once);
  });
});
