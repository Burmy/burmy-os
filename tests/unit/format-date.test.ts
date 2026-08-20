import { describe, expect, it } from 'vitest';

import { formatHumanDate } from '@/lib/format-date';

describe('formatHumanDate', () => {
  it('formats a plain ISO date without going through a timezone-aware Date', () => {
    expect(formatHumanDate('2026-05-02')).toBe('May 2, 2026');
  });

  it('does not zero-pad the day', () => {
    expect(formatHumanDate('2026-01-09')).toBe('Jan 9, 2026');
  });

  it('handles December correctly (month index 11)', () => {
    expect(formatHumanDate('2026-12-25')).toBe('Dec 25, 2026');
  });

  it('falls back to the raw string for something that is not a plain ISO date', () => {
    expect(formatHumanDate('not-a-date')).toBe('not-a-date');
  });
});
