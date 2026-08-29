import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_QUERY,
  LIST_QUERY,
  fuzzyDateToIso,
  hasNextActivityPage,
  joinGenres,
  mainStudio,
  parseActivityProgress,
  seriesRelatedIds,
  toActivities,
  toListEntries,
} from '@/server/anime/anilist';

/**
 * The pure half of the AniList integration.
 *
 * These matter more than usual because the live API could not be reached from
 * the environment this was written in — so the shaping is written to SURVIVE
 * being wrong about a field, and these tests are what prove it does. Every
 * "malformed" fixture below is a shape a real error response or an API change
 * could genuinely produce.
 */

function listPayload(entries: unknown[]): unknown {
  return { data: { MediaListCollection: { lists: [{ entries }] } } };
}

function entry(overrides: Record<string, unknown> = {}, media: Record<string, unknown> = {}): unknown {
  return {
    progress: 12,
    repeat: 0,
    status: 'CURRENT',
    startedAt: { year: 2024, month: 3, day: 1 },
    completedAt: { year: null, month: null, day: null },
    ...overrides,
    media: {
      id: 16498,
      title: { romaji: 'Shingeki no Kyojin', english: 'Attack on Titan' },
      episodes: 25,
      duration: 24,
      format: 'TV',
      season: 'SPRING',
      seasonYear: 2013,
      source: 'MANGA',
      genres: ['Action', 'Drama'],
      description: 'Humans versus titans.',
      coverImage: { large: 'https://img.anili.st/16498.jpg' },
      studios: { nodes: [{ name: 'Wit Studio' }] },
      relations: { edges: [] },
      ...media,
    },
  };
}

describe('queries', () => {
  it('ask for every field the entry shape needs', () => {
    // A field dropped from the query silently becomes null in every row, which
    // reads as missing data rather than as a broken query.
    for (const field of ['progress', 'repeat', 'status', 'episodes', 'duration', 'format', 'season', 'seasonYear', 'source', 'genres', 'relations']) {
      expect(LIST_QUERY).toContain(field);
    }
  });

  it('sorts activities by ID_DESC so paging is stable while new activity arrives', () => {
    expect(ACTIVITY_QUERY).toContain('ID_DESC');
    expect(ACTIVITY_QUERY).toContain('hasNextPage');
  });
});

describe('toListEntries', () => {
  it('shapes a real-looking entry into this app’s vocabulary', () => {
    const [row] = toListEntries(listPayload([entry()]));

    expect(row).toEqual({
      mediaId: 16498,
      titleRomaji: 'Shingeki no Kyojin',
      titleEnglish: 'Attack on Titan',
      status: 'watching',
      progress: 12,
      repeatCount: 0,
      episodes: 25,
      durationMinutes: 24,
      format: 'tv',
      season: 'spring',
      seasonYear: 2013,
      studio: 'Wit Studio',
      genre: 'Action, Drama',
      source: 'manga',
      synopsis: 'Humans versus titans.',
      coverUrl: 'https://img.anili.st/16498.jpg',
      startedAt: '2024-03-01',
      completedAt: null,
      relatedIds: [],
    });
  });

  it('collapses to [] for a payload with no list — the shape of an ERROR response', () => {
    // A GraphQL error response is `{ errors: [...] }` with no data at all.
    expect(toListEntries({ errors: [{ message: 'User not found' }] })).toEqual([]);
    expect(toListEntries(null)).toEqual([]);
    expect(toListEntries('nonsense')).toEqual([]);
    expect(toListEntries({ data: { MediaListCollection: null } })).toEqual([]);
  });

  it('skips an entry with no media id or no romaji title, keeping the rest', () => {
    // Both are required columns; a row that cannot be identified cannot be
    // matched on a later sync either.
    const rows = toListEntries(
      listPayload([entry({}, { id: null }), entry({}, { title: { romaji: null } }), entry()]),
    );
    expect(rows).toHaveLength(1);
  });

  it('defaults progress and repeat to 0, but leaves unknown COUNTS null', () => {
    // progress/repeat are non-null columns with a real zero meaning; episodes
    // and duration are genuinely unknown and must not become zero.
    const [row] = toListEntries(
      listPayload([entry({ progress: null, repeat: null }, { episodes: null, duration: null })]),
    );
    expect(row?.progress).toBe(0);
    expect(row?.repeatCount).toBe(0);
    expect(row?.episodes).toBeNull();
    expect(row?.durationMinutes).toBeNull();
  });

  it('reads every list in the collection, not just the first', () => {
    const payload = {
      data: { MediaListCollection: { lists: [{ entries: [entry()] }, { entries: [entry({}, { id: 999 })] }] } },
    };
    expect(toListEntries(payload)).toHaveLength(2);
  });
});

describe('fuzzyDateToIso', () => {
  it('formats a complete fuzzy date', () => {
    expect(fuzzyDateToIso({ year: 2024, month: 3, day: 7 })).toBe('2024-03-07');
  });

  it('is NULL for a partial date rather than inventing a day', () => {
    // Rendering a year-only date as 2013-01-01 is the fabricated-precision trap
    // `games.release_precision` exists to avoid.
    expect(fuzzyDateToIso({ year: 2013, month: null, day: null })).toBeNull();
    expect(fuzzyDateToIso({ year: 2013, month: 6, day: null })).toBeNull();
    expect(fuzzyDateToIso(null)).toBeNull();
  });

  it('rejects an out-of-range month or day', () => {
    expect(fuzzyDateToIso({ year: 2024, month: 13, day: 1 })).toBeNull();
    expect(fuzzyDateToIso({ year: 2024, month: 1, day: 40 })).toBeNull();
  });
});

describe('mainStudio and joinGenres', () => {
  it('reads the first named studio', () => {
    expect(mainStudio({ nodes: [{ name: 'MAPPA' }] })).toBe('MAPPA');
  });

  it('is null when the node list is empty or unusable', () => {
    expect(mainStudio({ nodes: [] })).toBeNull();
    expect(mainStudio({ nodes: [{ name: '' }] })).toBeNull();
    expect(mainStudio(null)).toBeNull();
  });

  it('joins genres the way games.genre is stored', () => {
    expect(joinGenres(['Action', 'Drama'])).toBe('Action, Drama');
  });

  it('is null rather than an empty string when there are none', () => {
    expect(joinGenres([])).toBeNull();
    expect(joinGenres(null)).toBeNull();
  });
});

describe('seriesRelatedIds', () => {
  const edge = (relationType: string, id: number, type = 'ANIME') => ({ relationType, node: { id, type } });

  it('keeps only the relations that mean "another season of this"', () => {
    const relations = {
      edges: [edge('SEQUEL', 2), edge('PREQUEL', 3), edge('PARENT', 4)],
    };
    expect(seriesRelatedIds(relations)).toEqual([2, 3, 4]);
  });

  it('drops SIDE_STORY, SPIN_OFF and the rest', () => {
    // Including them would file half of Gundam under one series.
    const relations = {
      edges: [edge('SIDE_STORY', 5), edge('SPIN_OFF', 6), edge('CHARACTER', 7), edge('SEQUEL', 8)],
    };
    expect(seriesRelatedIds(relations)).toEqual([8]);
  });

  it('drops a manga relation — an adaptation is not a season', () => {
    expect(seriesRelatedIds({ edges: [edge('PARENT', 9, 'MANGA')] })).toEqual([]);
  });

  it('is empty for an unusable shape', () => {
    expect(seriesRelatedIds(null)).toEqual([]);
    expect(seriesRelatedIds({ edges: 'nope' })).toEqual([]);
  });
});

describe('parseActivityProgress', () => {
  it('reads a single episode number', () => {
    expect(parseActivityProgress('7')).toBe(7);
    expect(parseActivityProgress(7)).toBe(7);
  });

  it('takes the UPPER bound of a catch-up range', () => {
    // AniList writes "5 - 8" when several episodes are logged at once. The log
    // records the episode REACHED.
    expect(parseActivityProgress('5 - 8')).toBe(8);
    expect(parseActivityProgress('10 - 12')).toBe(12);
  });

  it('is null rather than zero when AniList said nothing usable', () => {
    expect(parseActivityProgress(null)).toBeNull();
    expect(parseActivityProgress('')).toBeNull();
    expect(parseActivityProgress('watched')).toBeNull();
  });
});

describe('toActivities', () => {
  const activity = (overrides: Record<string, unknown> = {}) => ({
    id: 555,
    createdAt: 1_700_000_000,
    progress: '7',
    status: 'watched episode',
    media: { id: 16498 },
    ...overrides,
  });

  it('shapes a list activity', () => {
    expect(toActivities({ data: { Page: { activities: [activity()] } } })).toEqual([
      { activityId: 555, mediaId: 16498, createdAt: 1_700_000_000, progress: 7, status: 'watched episode' },
    ]);
  });

  it('skips the text and message activities mixed into the same array', () => {
    // The inline fragment leaves non-list activities as bare objects with none
    // of these fields; the id/media check drops them with no extra type test.
    const payload = {
      data: { Page: { activities: [{ id: 1, text: 'hello' }, activity()] } },
    };
    expect(toActivities(payload)).toHaveLength(1);
  });

  it('keeps a status-only activity, with a null episode', () => {
    const [row] = toActivities({ data: { Page: { activities: [activity({ progress: null, status: 'completed' })] } } });
    expect(row?.progress).toBeNull();
    expect(row?.status).toBe('completed');
  });

  it('collapses to [] on an error response', () => {
    expect(toActivities({ errors: [{ message: 'Not found' }] })).toEqual([]);
  });
});

describe('hasNextActivityPage', () => {
  it('is true only when AniList says so', () => {
    expect(hasNextActivityPage({ data: { Page: { pageInfo: { hasNextPage: true } } } })).toBe(true);
    expect(hasNextActivityPage({ data: { Page: { pageInfo: { hasNextPage: false } } } })).toBe(false);
  });

  it('is FALSE on any unexpected shape — stopping early beats looping forever', () => {
    expect(hasNextActivityPage(null)).toBe(false);
    expect(hasNextActivityPage({ errors: [] })).toBe(false);
    expect(hasNextActivityPage({ data: { Page: {} } })).toBe(false);
  });
});

describe('toListEntries — custom lists', () => {
  it('returns a show ONCE even when several lists carry it', () => {
    // AniList does not move an entry into a custom list, it copies it. A show
    // in both "Completed" and a custom "Favourites" comes back twice — and
    // undeduped it is counted twice in every total and staged as two
    // `new_anime` changes, the second of which fails the unique index.
    const duplicated = {
      data: {
        MediaListCollection: {
          lists: [{ entries: [entry()] }, { entries: [entry()] }],
        },
      },
    };

    expect(toListEntries(duplicated)).toHaveLength(1);
  });

  it('still keeps genuinely different shows across lists', () => {
    const twoShows = {
      data: {
        MediaListCollection: {
          lists: [{ entries: [entry()] }, { entries: [entry({}, { id: 21 })] }],
        },
      },
    };

    expect(toListEntries(twoShows).map((row) => row.mediaId)).toEqual([16498, 21]);
  });

  it('keeps the FIRST occurrence, so the result is deterministic', () => {
    const payload = {
      data: {
        MediaListCollection: {
          lists: [
            { entries: [entry({ progress: 12 })] },
            { entries: [entry({ progress: 99 })] },
          ],
        },
      },
    };

    expect(toListEntries(payload)[0]?.progress).toBe(12);
  });
});
