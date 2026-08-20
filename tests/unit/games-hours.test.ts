import { describe, expect, it } from 'vitest';

import { formatHours, fromHoursInput, hours, sumHours } from '@/server/games/hours';

describe('fromHoursInput', () => {
  it('parses a whole number of hours into tenths', () => {
    expect(fromHoursInput('53')).toBe(530);
  });

  it('parses one decimal place exactly', () => {
    expect(fromHoursInput('0.7')).toBe(7);
    expect(fromHoursInput('532.8')).toBe(5328);
  });

  it('rounds beyond one decimal place rather than storing a float', () => {
    expect(fromHoursInput('1.26')).toBe(13);
  });

  it('returns null for junk, empty, and negative input', () => {
    expect(fromHoursInput('')).toBeNull();
    expect(fromHoursInput('abc')).toBeNull();
    expect(fromHoursInput('-5')).toBeNull();
  });
});

describe('formatHours', () => {
  it('drops the decimal when the value is a whole number of hours', () => {
    expect(formatHours(hours(530))).toBe('53h');
  });

  it('keeps one decimal for a partial hour', () => {
    expect(formatHours(hours(7))).toBe('0.7h');
  });

  it('renders zero without a sign or decimal', () => {
    expect(formatHours(hours(0))).toBe('0h');
  });
});

describe('sumHours', () => {
  it('adds tenths exactly, with no floating-point drift', () => {
    // 0.1 + 0.2 in floats is 0.30000000000000004. In tenths it is simply 3.
    expect(sumHours([hours(1), hours(2)])).toBe(3);
  });

  it('returns zero for an empty list', () => {
    expect(sumHours([])).toBe(0);
  });
});
