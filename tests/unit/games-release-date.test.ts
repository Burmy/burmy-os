import { describe, expect, it } from 'vitest';

import { formatReleaseCountdown, isReleased, sortWishlist } from '@/server/games/release-date';

const NOW = new Date('2026-09-06T12:00:00.000Z');

/**
 * The whole point of storing `release_precision` rather than inferring it: a
 * month-precision row is written as `YYYY-MM-01`, so the day is a placeholder.
 * Every "month" case below passes a date whose day would read as a perfectly
 * plausible real one, and must still refuse to count down to it.
 */
describe('formatReleaseCountdown — month precision', () => {
  it('names the month and never counts down, even though the date has a day component', () => {
    expect(formatReleaseCountdown('2026-11-01', 'month', NOW)).toBe('November 2026');
  });

  it('does not fall back to a day even for a month that starts imminently', () => {
    // Two days out if the `-01` were believed. It is not.
    expect(formatReleaseCountdown('2026-09-01', 'month', NOW)).toBe('September 2026');
  });
});

describe('formatReleaseCountdown — day precision', () => {
  it('counts down in whole days when the release is close', () => {
    expect(formatReleaseCountdown('2026-09-18', 'day', NOW)).toBe('in 12 days');
  });

  it('names the day for today and tomorrow rather than printing "in 0 days"', () => {
    expect(formatReleaseCountdown('2026-09-06', 'day', NOW)).toBe('Out today');
    expect(formatReleaseCountdown('2026-09-07', 'day', NOW)).toBe('Tomorrow');
  });

  /**
   * A countdown stops being useful long before it stops being accurate — "in
   * 154 days" is a number you have to do arithmetic on, where a date is not.
   */
  it('switches to an absolute date beyond the countdown horizon', () => {
    expect(formatReleaseCountdown('2027-02-20', 'day', NOW)).toBe('Feb 20, 2027');
  });

  it('holds the countdown right up to the horizon and switches one day past it', () => {
    expect(formatReleaseCountdown('2026-11-05', 'day', NOW)).toBe('in 60 days');
    expect(formatReleaseCountdown('2026-11-06', 'day', NOW)).toBe('Nov 6, 2026');
  });

  /**
   * A wishlist row whose date has passed but which the auto-flip hasn't yet
   * promoted to `backlog` — the flip only runs on the Upcoming page, so this
   * state is genuinely reachable in the library.
   */
  it('says the game is out rather than counting backwards', () => {
    expect(formatReleaseCountdown('2026-09-01', 'day', NOW)).toBe('Out now');
  });

  /**
   * Both sides are floored to UTC midnight before subtracting, so the answer
   * is a whole number of CALENDAR days. Without that, a release 25 hours out
   * would round to 1 day at one moment and 2 at another, and the pill would
   * change while the owner watched it.
   */
  it('counts calendar days, not elapsed hours', () => {
    const lateInDay = new Date('2026-09-06T23:59:00.000Z');
    const earlyInDay = new Date('2026-09-06T00:01:00.000Z');
    expect(formatReleaseCountdown('2026-09-08', 'day', lateInDay)).toBe('in 2 days');
    expect(formatReleaseCountdown('2026-09-08', 'day', earlyInDay)).toBe('in 2 days');
  });
});

describe('formatReleaseCountdown — once a month-precision date has passed', () => {
  it('says "Out now" for a month strictly before the current one', () => {
    expect(formatReleaseCountdown('2026-08-01', 'month', NOW)).toBe('Out now');
  });

  it('still names the month while it is the CURRENT month — the day is unknown', () => {
    const now = new Date('2026-11-20T12:00:00Z');
    expect(formatReleaseCountdown('2026-11-01', 'month', now)).toBe('November 2026');
  });
});

describe('isReleased', () => {
  it('treats a day-precision date as released on the day itself and after', () => {
    expect(isReleased('2026-09-06', 'day', NOW)).toBe(true);
    expect(isReleased('2026-09-01', 'day', NOW)).toBe(true);
    expect(isReleased('2026-09-07', 'day', NOW)).toBe(false);
  });

  it('treats a month-precision date as released only once the whole month is behind us', () => {
    expect(isReleased('2026-08-01', 'month', NOW)).toBe(true);
    expect(isReleased('2026-09-01', 'month', NOW)).toBe(false);
    expect(isReleased('2026-10-01', 'month', NOW)).toBe(false);
  });

  it('is false for garbage rather than throwing', () => {
    expect(isReleased('soon', 'day', NOW)).toBe(false);
  });
});

describe('sortWishlist', () => {
  const entry = (
    title: string,
    releaseDate: string | null,
    releasePrecision: 'day' | 'month' | null = 'day',
  ) => ({
    title,
    releaseDate,
    releasePrecision,
  });

  it('puts released games first, then dated games soonest first, then undated, each alphabetical', () => {
    const sorted = sortWishlist(
      [
        entry('Zeta (no date)', null, null),
        entry('Later', '2027-03-01', 'month'),
        entry('Soon', '2026-10-02'),
        entry('Bravo (out)', '2026-01-10'),
        entry('Alpha (no date)', null, null),
        entry('Alpha (out)', '2026-05-05'),
      ],
      NOW,
    ).map((game) => game.title);

    expect(sorted).toEqual([
      'Alpha (out)',
      'Bravo (out)',
      'Soon',
      'Later',
      'Alpha (no date)',
      'Zeta (no date)',
    ]);
  });

  it('does not mutate its input', () => {
    const input = [entry('B', null, null), entry('A', null, null)];
    sortWishlist(input, NOW);
    expect(input.map((game) => game.title)).toEqual(['B', 'A']);
  });
});
