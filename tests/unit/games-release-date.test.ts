import { describe, expect, it } from 'vitest';

import { formatReleaseCountdown } from '@/server/games/release-date';

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
    expect(formatReleaseCountdown('2026-09-01', 'day', NOW)).toBe('Released');
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
