import { describe, expect, it } from 'vitest';

import { formatRelativeTime } from '@/lib/relative-time';

/**
 * Pure phrase formatting — no rendering, no clock dependency (`now` is
 * always pinned). Coarse by design: the largest whole unit only.
 */
describe('formatRelativeTime', () => {
  const now = new Date('2026-08-25T12:00:00.000Z');

  it('reports "just now" for anything under a minute', () => {
    expect(formatRelativeTime(new Date(now.getTime() - 30_000), now)).toBe('just now');
    expect(formatRelativeTime(now, now)).toBe('just now');
  });

  it('reports singular and plural minutes', () => {
    expect(formatRelativeTime(new Date(now.getTime() - 60_000), now)).toBe('1 minute ago');
    expect(formatRelativeTime(new Date(now.getTime() - 5 * 60_000), now)).toBe('5 minutes ago');
  });

  it('reports singular and plural hours', () => {
    expect(formatRelativeTime(new Date(now.getTime() - 60 * 60_000), now)).toBe('1 hour ago');
    expect(formatRelativeTime(new Date(now.getTime() - 3 * 60 * 60_000), now)).toBe('3 hours ago');
  });

  it('reports singular and plural days', () => {
    expect(formatRelativeTime(new Date(now.getTime() - 24 * 60 * 60_000), now)).toBe('1 day ago');
    expect(formatRelativeTime(new Date(now.getTime() - 3 * 24 * 60 * 60_000), now)).toBe('3 days ago');
  });

  it('reports months once past 30 days', () => {
    expect(formatRelativeTime(new Date(now.getTime() - 30 * 24 * 60 * 60_000), now)).toBe('1 month ago');
    expect(formatRelativeTime(new Date(now.getTime() - 90 * 24 * 60 * 60_000), now)).toBe('3 months ago');
  });

  it('reports years once past 12 months', () => {
    expect(formatRelativeTime(new Date(now.getTime() - 366 * 24 * 60 * 60_000), now)).toBe('1 year ago');
  });

  it('clamps a future date (clock skew) to "just now" rather than a negative phrase', () => {
    expect(formatRelativeTime(new Date(now.getTime() + 60_000), now)).toBe('just now');
  });
});
