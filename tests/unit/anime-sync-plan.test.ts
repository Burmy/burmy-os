import { describe, expect, it } from 'vitest';

import type { AniListEntry } from '@/server/anime/anilist';
import {
  type StoredAnimeForSync,
  defaultSelected,
  planLinkedAnimeChanges,
  planNewAnimeChange,
  planSeriesHint,
} from '@/server/anime/sync-plan';

/**
 * What a sync PROPOSES. Pure, so no mocking — and the rules that matter most
 * are the ones about what it refuses to propose: a sync that stages a no-op
 * every run trains the owner to approve without reading, and a sync that
 * overwrites a hand-corrected field with a null is data loss.
 */

function stored(overrides: Partial<StoredAnimeForSync> = {}): StoredAnimeForSync {
  return {
    id: 'row-1',
    title: 'Shingeki no Kyojin',
    anilistMediaId: 16498,
    status: 'watching',
    progress: 12,
    repeatCount: 0,
    episodes: 25,
    durationMinutes: 24,
    studio: 'Wit Studio',
    genre: 'Action, Drama',
    coverUrl: 'https://img/16498.jpg',
    ...overrides,
  };
}

function entry(overrides: Partial<AniListEntry> = {}): AniListEntry {
  return {
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
    coverUrl: 'https://img/16498.jpg',
    startedAt: '2024-03-01',
    completedAt: null,
    relatedIds: [],
    ...overrides,
  };
}

const fields = (changes: readonly { payload: Record<string, unknown> }[]): unknown[] =>
  changes.map((change) => change.payload.field);

describe('planLinkedAnimeChanges — the no-op guard', () => {
  it('proposes NOTHING when AniList agrees with everything stored', () => {
    // The single most important test here. A sync that proposes the same
    // no-op every run is a sync the owner stops reading.
    expect(planLinkedAnimeChanges(stored(), entry())).toEqual([]);
  });
});

describe('planLinkedAnimeChanges — progress and status', () => {
  it('proposes progress when AniList has moved ahead', () => {
    const changes = planLinkedAnimeChanges(stored(), entry({ progress: 18 }));
    expect(changes).toHaveLength(1);
    expect(changes[0]?.payload).toEqual({ field: 'progress', from: 12, to: 18 });
  });

  it('FLAGS a decrease rather than applying it quietly', () => {
    // AniList is where watching is logged, so its progress is normally ahead.
    // A lower number is a re-add or a list edit, and rewinding episode 12 to
    // episode 3 unannounced is indistinguishable from data loss.
    const [change] = planLinkedAnimeChanges(stored(), entry({ progress: 3 }));
    expect(change?.payload).toEqual({ field: 'progress', from: 12, to: 3, decrease: true });
  });

  it('does not flag an increase', () => {
    const [change] = planLinkedAnimeChanges(stored(), entry({ progress: 20 }));
    expect(change?.payload).not.toHaveProperty('decrease');
  });

  it('proposes a status change and a rewatch count', () => {
    const changes = planLinkedAnimeChanges(
      stored(),
      entry({ status: 'completed', progress: 25, repeatCount: 1 }),
    );
    expect(fields(changes)).toEqual(['status', 'progress', 'repeatCount']);
  });
});

describe('planLinkedAnimeChanges — metadata never overwrites with a null', () => {
  it('proposes nothing for a field AniList does not know', () => {
    // `null` from AniList means "AniList did not say", never "the value is
    // zero" — writing it would erase a real recorded number.
    const blank = entry({ episodes: null, durationMinutes: null, studio: null, genre: null });
    expect(planLinkedAnimeChanges(stored(), blank)).toEqual([]);
  });

  it('proposes episodes when AniList has a different count', () => {
    // This one matters beyond tidiness: rewatch time is repeat x episodes, so
    // a stale count silently misreports the headline figure.
    const [change] = planLinkedAnimeChanges(stored(), entry({ episodes: 26 }));
    expect(change?.payload).toEqual({ field: 'episodes', from: 25, to: 26 });
  });

  it('proposes studio and genre when they differ', () => {
    const changes = planLinkedAnimeChanges(stored(), entry({ studio: 'MAPPA', genre: 'Action' }));
    expect(fields(changes)).toEqual(['studio', 'genre']);
  });
});

describe('planLinkedAnimeChanges — cover art fills, never replaces', () => {
  it('fills a missing cover', () => {
    const [change] = planLinkedAnimeChanges(stored({ coverUrl: null }), entry());
    expect(change?.payload).toEqual({ field: 'coverUrl', from: null, to: 'https://img/16498.jpg' });
  });

  it('leaves an existing cover alone even when AniList has a different one', () => {
    // The owner may have set it deliberately, and a churning AniList image
    // would propose the same swap forever.
    const changes = planLinkedAnimeChanges(stored(), entry({ coverUrl: 'https://img/other.jpg' }));
    expect(changes).toEqual([]);
  });
});

describe('planLinkedAnimeChanges — linking', () => {
  it('proposes a link for a row that has no AniList id yet', () => {
    const changes = planLinkedAnimeChanges(stored({ anilistMediaId: null }), entry());
    expect(changes[0]).toEqual({
      kind: 'link',
      animeId: 'row-1',
      title: 'Shingeki no Kyojin',
      // `matchedTitle` rides along for display only. A link can now come from a
      // TITLE match on a hand-added show, and "matched to #16498" is
      // unverifiable — the review screen shows both titles side by side so a
      // wrong match can be caught, which is why it needs approving at all.
      payload: { anilistMediaId: 16498, matchedTitle: 'Shingeki no Kyojin' },
    });
  });

  it('does not re-link a row that already carries the id', () => {
    expect(planLinkedAnimeChanges(stored(), entry()).some((c) => c.kind === 'link')).toBe(false);
  });

  it('carries the row id and title on every change it produces', () => {
    const changes = planLinkedAnimeChanges(stored({ anilistMediaId: null }), entry({ progress: 20 }));
    for (const change of changes) {
      expect(change.animeId).toBe('row-1');
      expect(change.title).toBe('Shingeki no Kyojin');
    }
  });
});

describe('planNewAnimeChange', () => {
  it('carries everything needed to create the row, since the snapshot is gone by commit time', () => {
    const change = planNewAnimeChange(entry());

    expect(change.kind).toBe('new_anime');
    expect(change.animeId).toBeNull();
    for (const key of ['anilistMediaId', 'titleRomaji', 'status', 'progress', 'episodes', 'format', 'coverUrl']) {
      expect(change.payload).toHaveProperty(key);
    }
  });
});

describe('planSeriesHint', () => {
  const members = [
    { mediaId: 16498, titleRomaji: 'Shingeki no Kyojin', seasonYear: 2013 },
    { mediaId: 99147, titleRomaji: 'Shingeki no Kyojin Season 3', seasonYear: 2018 },
    { mediaId: 25777, titleRomaji: 'Shingeki no Kyojin Season 2', seasonYear: 2017 },
  ];

  it('is never pre-selected', () => {
    // Series membership decides how the library COUNTS and GROUPS, and a
    // relation graph is sure about sequels and much less sure about recaps,
    // compilation films and side stories.
    expect(defaultSelected('series_hint')).toBe(false);
    expect(defaultSelected('new_anime')).toBe(true);
    expect(defaultSelected('field_update')).toBe(true);
    expect(defaultSelected('link')).toBe(true);
  });

  it('refuses to call one show a franchise', () => {
    expect(planSeriesHint([members[0]!], 'Shingeki no Kyojin', 16498)).toBeNull();
    expect(planSeriesHint([], 'Anything', 1)).toBeNull();
  });

  it('carries what the COMMIT needs to actually do the work', () => {
    // The first version of this staged an advisory note that applied nothing —
    // a checkbox that counted toward "Apply N selected changes" and then did
    // nothing at all.
    const hint = planSeriesHint(members, 'Shingeki no Kyojin', 16498);
    expect(hint?.payload.anilistParentId).toBe(16498);
    expect(hint?.payload.seriesTitle).toBe('Shingeki no Kyojin');
    expect(hint?.payload.mediaIds).toHaveLength(3);
  });

  it('lists the members in airing order, which is watching order', () => {
    const hint = planSeriesHint(members, 'Shingeki no Kyojin', 16498);
    expect(hint?.payload.titles).toEqual([
      'Shingeki no Kyojin',
      'Shingeki no Kyojin Season 2',
      'Shingeki no Kyojin Season 3',
    ]);
    expect(hint?.payload.mediaIds).toEqual([16498, 25777, 99147]);
  });

  it('belongs to no single row, because it is about a SET', () => {
    expect(planSeriesHint(members, 'Shingeki no Kyojin', 16498)?.animeId).toBeNull();
  });

  it('sorts an undated member last rather than ahead of season one', () => {
    const hint = planSeriesHint(
      [
        { mediaId: 2, titleRomaji: 'Special', seasonYear: null },
        { mediaId: 1, titleRomaji: 'Season 1', seasonYear: 2013 },
      ],
      'Show',
      1,
    );
    expect(hint?.payload.titles).toEqual(['Season 1', 'Special']);
  });
});
