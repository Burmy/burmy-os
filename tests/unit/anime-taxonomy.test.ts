import { describe, expect, it } from 'vitest';

import {
  ANIME_STATUSES,
  formatAiring,
  formatFromAniList,
  seasonFromAniList,
  sourceFromAniList,
  statusFromAniList,
} from '@/server/anime/taxonomy';

/**
 * The AniList→Burmy vocabulary mapping. Everything here runs over 300 rows on
 * every sync, so the rule that matters most is that an UNRECOGNISED value
 * degrades rather than throwing — one unfamiliar format must not fail an
 * import of the whole library.
 */

describe('statusFromAniList', () => {
  it('folds the six AniList statuses into four', () => {
    expect(statusFromAniList('CURRENT')).toBe('watching');
    expect(statusFromAniList('COMPLETED')).toBe('completed');
    expect(statusFromAniList('DROPPED')).toBe('dropped');
    expect(statusFromAniList('PLANNING')).toBe('planning');
  });

  it('folds PAUSED into watching and REPEATING into completed', () => {
    // The owner's choice. Nothing is lost by folding REPEATING because
    // `repeat_count` carries the rewatch signal separately.
    expect(statusFromAniList('PAUSED')).toBe('watching');
    expect(statusFromAniList('REPEATING')).toBe('completed');
  });

  it('degrades an unknown status to planning rather than throwing', () => {
    expect(statusFromAniList('SOMETHING_NEW')).toBe('planning');
    expect(statusFromAniList(null)).toBe('planning');
    expect(statusFromAniList(42)).toBe('planning');
  });

  it('maps every result to a real status', () => {
    for (const raw of ['CURRENT', 'PAUSED', 'COMPLETED', 'REPEATING', 'DROPPED', 'PLANNING', 'JUNK']) {
      expect(ANIME_STATUSES).toContain(statusFromAniList(raw));
    }
  });
});

describe('formatFromAniList', () => {
  it('lowercases the ones this app knows', () => {
    expect(formatFromAniList('TV')).toBe('tv');
    expect(formatFromAniList('TV_SHORT')).toBe('tv_short');
    expect(formatFromAniList('MOVIE')).toBe('movie');
    expect(formatFromAniList('OVA')).toBe('ova');
  });

  it('is NULL for an unrecognised format — a missing field, never a guess', () => {
    expect(formatFromAniList('MANGA')).toBeNull();
    expect(formatFromAniList(undefined)).toBeNull();
  });
});

describe('seasonFromAniList', () => {
  it('maps the four seasons', () => {
    expect(seasonFromAniList('SPRING')).toBe('spring');
    expect(seasonFromAniList('FALL')).toBe('fall');
  });

  it('is null for anything else', () => {
    expect(seasonFromAniList('AUTUMN')).toBeNull();
    expect(seasonFromAniList(null)).toBeNull();
  });
});

describe('sourceFromAniList', () => {
  it('maps the ones this app enumerates', () => {
    expect(sourceFromAniList('MANGA')).toBe('manga');
    expect(sourceFromAniList('LIGHT_NOVEL')).toBe('light_novel');
    expect(sourceFromAniList('ORIGINAL')).toBe('original');
  });

  it('collapses AniList values this app does not enumerate into "other"', () => {
    // WEB_NOVEL, LIVE_ACTION, GAME, COMIC, MULTIMEDIA_PROJECT, PICTURE_BOOK.
    // The stats page groups by source and nine buckets is already the edge of
    // useful, so these fold rather than each earning a slice.
    expect(sourceFromAniList('WEB_NOVEL')).toBe('other');
    expect(sourceFromAniList('LIVE_ACTION')).toBe('other');
  });

  it('is null only when AniList said nothing at all', () => {
    expect(sourceFromAniList(null)).toBeNull();
    expect(sourceFromAniList(undefined)).toBeNull();
  });
});

describe('formatAiring', () => {
  it('reads as a season and year', () => {
    expect(formatAiring('spring', 2013)).toBe('Spring 2013');
  });

  it('still says something useful with only half of it', () => {
    expect(formatAiring(null, 2013)).toBe('2013');
    expect(formatAiring('spring', null)).toBe('Spring');
  });

  it('is null when neither half is known', () => {
    expect(formatAiring(null, null)).toBeNull();
  });
});
