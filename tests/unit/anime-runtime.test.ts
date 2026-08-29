import { describe, expect, it } from 'vitest';

import {
  type Minutes,
  episodesWatched,
  formatRuntime,
  minutes,
  minutesWatched,
  sumMinutes,
  watchPercent,
} from '@/server/anime/runtime';

/**
 * The one module allowed to do episode and time arithmetic. Every figure the
 * library and stats page lead with comes from here, so the rules that matter
 * most are the ones about what it REFUSES to compute: an unknown duration must
 * never become a zero, because a zero silently shrinks every total it is summed
 * into and looks exactly like a real answer.
 */

describe('episodesWatched', () => {
  it('is just progress for a first watch', () => {
    expect(episodesWatched(12, 0, 24)).toBe(12);
  });

  it('counts every rewatch in full', () => {
    // The owner's explicit decision: a 24-episode show seen three times is 72
    // episodes of time actually spent, not 24.
    expect(episodesWatched(24, 2, 24)).toBe(72);
  });

  it('counts a partial rewatch on top of completed ones', () => {
    expect(episodesWatched(5, 1, 24)).toBe(29);
  });

  it('ignores rewatches when the show has no known length', () => {
    // An airing show AniList has no final count for. A rewatch cannot be
    // valued without a length, so only current progress counts — under-report
    // rather than invent an episode count.
    expect(episodesWatched(8, 3, null)).toBe(8);
    expect(episodesWatched(8, 3, 0)).toBe(8);
  });

  it('never returns a negative from malformed stored values', () => {
    expect(episodesWatched(-4, -1, 24)).toBe(0);
  });
});

describe('minutesWatched', () => {
  it('multiplies episodes watched by the per-episode length', () => {
    // 24 episodes x 24 minutes = 576.
    expect(minutesWatched(24, 0, 24, 24)).toBe(576);
  });

  it('scales with rewatches', () => {
    expect(minutesWatched(24, 2, 24, 24)).toBe(1728);
  });

  it('is NULL when the duration is unknown, never zero', () => {
    // A zero here would quietly shrink every total this is summed into, while
    // reading exactly like a real answer.
    expect(minutesWatched(24, 0, 24, null)).toBeNull();
    expect(minutesWatched(24, 0, 24, 0)).toBeNull();
  });

  it('handles a movie — one "episode", feature length', () => {
    expect(minutesWatched(1, 0, 1, 120)).toBe(120);
  });
});

describe('formatRuntime', () => {
  it('reads as a duration a person can feel', () => {
    expect(formatRuntime(minutes(0))).toBe('0m');
    expect(formatRuntime(minutes(24))).toBe('24m');
    expect(formatRuntime(minutes(576))).toBe('9h 36m');
    expect(formatRuntime(minutes(1440))).toBe('1d');
    expect(formatRuntime(minutes(55_200))).toBe('38d 8h');
  });

  it('drops a trailing zero unit rather than printing it', () => {
    expect(formatRuntime(minutes(120))).toBe('2h');
    expect(formatRuntime(minutes(2880))).toBe('2d');
  });

  it('shows at most two units', () => {
    // 38d 8h 12m -> the minutes are noise at that scale, and three units wrap
    // a stat card.
    expect(formatRuntime(minutes(55_212))).toBe('38d 8h');
  });
});

describe('sumMinutes', () => {
  it('adds the known values', () => {
    expect(sumMinutes([minutes(100), minutes(200)])).toBe(300);
  });

  it('skips unknowns rather than treating them as zero', () => {
    expect(sumMinutes([minutes(100), null, minutes(50)])).toBe(150);
  });

  it('is null when nothing at all was known', () => {
    expect(sumMinutes([null, null])).toBeNull();
    expect(sumMinutes([])).toBeNull();
  });
});

describe('watchPercent', () => {
  it('reports progress through the current watch', () => {
    expect(watchPercent(12, 24)).toBe(50);
    expect(watchPercent(0, 24)).toBe(0);
    expect(watchPercent(24, 24)).toBe(100);
  });

  it('is null when the show has no known length', () => {
    expect(watchPercent(8, null)).toBeNull();
  });

  it('clamps above 100 — AniList carries progress past a stale episode count on airing shows', () => {
    expect(watchPercent(30, 24)).toBe(100);
  });
});

describe('minutes', () => {
  it('refuses a fractional value', () => {
    // The brand exists so a raw number cannot stand in for a computed
    // duration; the runtime check is what stops a float ever reaching a total.
    expect(() => minutes(1.5)).toThrow(TypeError);
  });

  it('accepts a whole number', () => {
    const value: Minutes = minutes(42);
    expect(value).toBe(42);
  });
});
