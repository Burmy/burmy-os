import { describe, expect, it } from 'vitest';

import {
  type AnimeStatRow,
  buildAiringEras,
  buildCompletionRates,
  buildFormatDistribution,
  buildGenreDistribution,
  buildLeaderboard,
  buildLibrarySummary,
  buildSourceDistribution,
  buildStudioDistribution,
  capSlices,
  splitGenres,
} from '@/server/anime/stats';

function show(overrides: Partial<AnimeStatRow> & { readonly id: string }): AnimeStatRow {
  return {
    titleRomaji: overrides.id,
    titleEnglish: null,
    status: 'completed',
    format: 'tv',
    source: 'manga',
    episodes: 12,
    progress: 12,
    repeatCount: 0,
    durationMinutes: 24,
    season: 'spring',
    seasonYear: 2020,
    studio: 'Studio Ghost',
    genre: 'Action, Drama',
    coverUrl: null,
    ...overrides,
  };
}

describe('buildLibrarySummary', () => {
  it('counts shows and episodes, rewatches included', () => {
    const summary = buildLibrarySummary([
      show({ id: 'a', episodes: 12, progress: 12, repeatCount: 2 }),
      show({ id: 'b', episodes: 24, progress: 10 }),
    ]);
    expect(summary.showCount).toBe(2);
    expect(summary.episodesWatched).toBe(36 + 10);
  });

  it('reports what the rewatches ALONE account for', () => {
    // 12 watched three times is 36 episodes, of which 24 are rewatch.
    const summary = buildLibrarySummary([show({ id: 'a', episodes: 12, progress: 12, repeatCount: 2 })]);
    expect(summary.rewatchedCount).toBe(1);
    expect(summary.rewatchEpisodes).toBe(24);
  });

  it('counts a show with no rewatches as none', () => {
    const summary = buildLibrarySummary([show({ id: 'a' })]);
    expect(summary.rewatchedCount).toBe(0);
    expect(summary.rewatchEpisodes).toBe(0);
  });

  it('buckets by status', () => {
    const summary = buildLibrarySummary([
      show({ id: 'a', status: 'watching' }),
      show({ id: 'b', status: 'completed' }),
      show({ id: 'c', status: 'completed' }),
      show({ id: 'd', status: 'dropped' }),
      show({ id: 'e', status: 'planning' }),
    ]);
    expect(summary.byStatus).toEqual({ watching: 1, completed: 2, dropped: 1, planning: 1 });
  });

  it('never turns an unknown episode length into zero minutes', () => {
    const summary = buildLibrarySummary([
      show({ id: 'known', episodes: 12, progress: 12, durationMinutes: 24 }),
      show({ id: 'unknown', episodes: 12, progress: 12, durationMinutes: null }),
    ]);
    expect(summary.minutesWatched).toBe(288);
    expect(summary.unknownDurationCount).toBe(1);
  });

  it('reports null minutes — never 0 — when NOTHING has a known length', () => {
    // "0h watched" over a real library is a lie; "—" is the truth.
    const summary = buildLibrarySummary([show({ id: 'a', durationMinutes: null })]);
    expect(summary.minutesWatched).toBeNull();
    expect(summary.episodesWatched).toBe(12);
  });

  it('is zeroed, not broken, on an empty library', () => {
    const summary = buildLibrarySummary([]);
    expect(summary.showCount).toBe(0);
    expect(summary.minutesWatched).toBeNull();
  });
});

describe('buildCompletionRates', () => {
  it('measures follow-through only among shows actually started', () => {
    // A watchlist of things not begun says nothing about whether the owner
    // finishes what they start.
    const rates = buildCompletionRates([
      show({ id: 'a', status: 'completed' }),
      show({ id: 'b', status: 'completed' }),
      show({ id: 'c', status: 'dropped' }),
      show({ id: 'd', status: 'watching' }),
      show({ id: 'e', status: 'planning' }),
      show({ id: 'f', status: 'planning' }),
    ]);
    expect(rates.startedCount).toBe(4);
    expect(rates.completionRate).toBe(50);
    expect(rates.dropRate).toBe(25);
  });

  it('reports null, not 0%, when nothing has been started', () => {
    const rates = buildCompletionRates([show({ id: 'a', status: 'planning' })]);
    expect(rates.startedCount).toBe(0);
    expect(rates.completionRate).toBeNull();
    expect(rates.dropRate).toBeNull();
  });

  it('is null on an empty library rather than dividing by zero', () => {
    expect(buildCompletionRates([]).completionRate).toBeNull();
  });
});

describe('distributions', () => {
  it('groups formats by their label, biggest first', () => {
    const slices = buildFormatDistribution([
      show({ id: 'a', format: 'tv' }),
      show({ id: 'b', format: 'tv' }),
      show({ id: 'c', format: 'movie' }),
    ]);
    expect(slices.map((s) => [s.label, s.count])).toEqual([
      ['TV', 2],
      ['Movie', 1],
    ]);
  });

  it('leaves a missing format OUT rather than inventing an "Unknown" kind of anime', () => {
    const slices = buildFormatDistribution([show({ id: 'a', format: null }), show({ id: 'b', format: 'tv' })]);
    expect(slices).toHaveLength(1);
  });

  it('carries episodes alongside the count, so "8 shows" and "620 episodes" can differ', () => {
    const slices = buildFormatDistribution([
      show({ id: 'a', format: 'tv', episodes: 25, progress: 25 }),
      show({ id: 'b', format: 'tv', episodes: 12, progress: 12 }),
    ]);
    expect(slices[0]).toEqual({ label: 'TV', count: 2, episodes: 37 });
  });

  it('groups sources by their label', () => {
    const slices = buildSourceDistribution([
      show({ id: 'a', source: 'manga' }),
      show({ id: 'b', source: 'light_novel' }),
    ]);
    expect(slices.map((s) => s.label).sort()).toEqual(['Light novel', 'Manga']);
  });

  it('skips a blank studio rather than grouping under an empty name', () => {
    const slices = buildStudioDistribution([
      show({ id: 'a', studio: 'Bones' }),
      show({ id: 'b', studio: '   ' }),
      show({ id: 'c', studio: null }),
    ]);
    expect(slices).toEqual([{ label: 'Bones', count: 1, episodes: 12 }]);
  });

  it('breaks a count tie alphabetically, so a redraw is stable', () => {
    const slices = buildStudioDistribution([show({ id: 'a', studio: 'Wit' }), show({ id: 'b', studio: 'Bones' })]);
    expect(slices.map((s) => s.label)).toEqual(['Bones', 'Wit']);
  });
});

describe('genres', () => {
  it('splits a comma-joined string', () => {
    expect(splitGenres('Action, Drama, Fantasy')).toEqual(['Action', 'Drama', 'Fantasy']);
  });

  it('is empty for null and for a blank string', () => {
    expect(splitGenres(null)).toEqual([]);
    expect(splitGenres('  ,  ')).toEqual([]);
  });

  it('counts a show once in EVERY genre it carries', () => {
    // These slices deliberately do not sum to the library size.
    const slices = buildGenreDistribution([show({ id: 'a', genre: 'Action, Drama' })]);
    expect(slices.map((s) => s.label).sort()).toEqual(['Action', 'Drama']);
    expect(slices.every((s) => s.count === 1)).toBe(true);
  });
});

describe('capSlices', () => {
  const slices = Array.from({ length: 12 }, (_, i) => ({
    label: `G${i}`,
    count: 12 - i,
    episodes: (12 - i) * 10,
  }));

  it('leaves a short list alone', () => {
    expect(capSlices(slices.slice(0, 3), 8)).toHaveLength(3);
  });

  it('collapses the tail into one row that says how many it swallowed', () => {
    const capped = capSlices(slices, 8);
    expect(capped).toHaveLength(9);
    expect(capped[8]?.label).toBe('Other (4)');
  });

  it('preserves the totals it collapsed', () => {
    const capped = capSlices(slices, 8);
    const tail = slices.slice(8);
    expect(capped[8]?.count).toBe(tail.reduce((s, x) => s + x.count, 0));
    expect(capped[8]?.episodes).toBe(tail.reduce((s, x) => s + x.episodes, 0));
  });
});

describe('buildAiringEras', () => {
  it('groups by the year a show AIRED, not the year it was watched', () => {
    // A question about taste. Rewatching a 2013 show in 2026 must not move it.
    const eras = buildAiringEras([
      show({ id: 'a', seasonYear: 2013, repeatCount: 3 }),
      show({ id: 'b', seasonYear: 2020 }),
      show({ id: 'c', seasonYear: 2020 }),
    ]);
    expect(eras.map((e) => [e.year, e.showCount])).toEqual([
      [2013, 1],
      [2020, 2],
    ]);
  });

  it('drops an undated show instead of planting a bar at year zero', () => {
    expect(buildAiringEras([show({ id: 'a', seasonYear: null })])).toEqual([]);
  });

  it('runs oldest to newest, whatever order the rows arrive in', () => {
    const eras = buildAiringEras([
      show({ id: 'a', seasonYear: 2023 }),
      show({ id: 'b', seasonYear: 2009 }),
      show({ id: 'c', seasonYear: 2016 }),
    ]);
    expect(eras.map((e) => e.year)).toEqual([2009, 2016, 2023]);
  });
});

describe('buildLeaderboard', () => {
  it('ranks by episodes watched, rewatches included', () => {
    const top = buildLeaderboard(
      [
        show({ id: 'short', titleRomaji: 'Short', episodes: 12, progress: 12 }),
        show({ id: 'long', titleRomaji: 'Long', episodes: 64, progress: 64 }),
        show({ id: 'rewatched', titleRomaji: 'Rewatched', episodes: 25, progress: 25, repeatCount: 3 }),
      ],
      3,
    );
    expect(top.map((e) => e.title)).toEqual(['Rewatched', 'Long', 'Short']);
  });

  it('keeps a show whose episode length is unknown, with a null estimate', () => {
    // Silently omitting it would look like a bug on a leaderboard.
    const top = buildLeaderboard([show({ id: 'a', durationMinutes: null })], 5);
    expect(top).toHaveLength(1);
    expect(top[0]?.minutes).toBeNull();
  });

  it('leaves out a show with nothing watched yet', () => {
    const top = buildLeaderboard([show({ id: 'a', progress: 0, repeatCount: 0 })], 5);
    expect(top).toEqual([]);
  });

  it('prefers the English title when there is one', () => {
    const top = buildLeaderboard([show({ id: 'a', titleRomaji: 'Sousou no Frieren', titleEnglish: 'Frieren' })], 5);
    expect(top[0]?.title).toBe('Frieren');
  });

  it('honours the limit', () => {
    const rows = Array.from({ length: 20 }, (_, i) => show({ id: `s${i}`, episodes: 20 - i, progress: 20 - i }));
    expect(buildLeaderboard(rows, 5)).toHaveLength(5);
  });
});
