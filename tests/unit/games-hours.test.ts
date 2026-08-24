import { describe, expect, it } from 'vitest';

import {
  formatHours,
  fromHoursInput,
  hours,
  minutesToHoursTenths,
  sumHours,
  toHoursInput,
} from '@/server/games/hours';

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

describe('toHoursInput', () => {
  it('is the inverse of fromHoursInput for a whole number of hours', () => {
    expect(toHoursInput(hours(230))).toBe('23');
  });

  it('is the inverse of fromHoursInput for a partial hour', () => {
    expect(toHoursInput(hours(235))).toBe('23.5');
  });

  it('renders zero as "0", not an empty string', () => {
    expect(toHoursInput(hours(0))).toBe('0');
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

describe('minutesToHoursTenths', () => {
  it('converts 0 minutes to exactly 0 tenths, not NaN or -0', () => {
    expect(minutesToHoursTenths(0)).toBe(0);
    expect(Object.is(minutesToHoursTenths(0), -0)).toBe(false);
  });

  it('converts a whole number of hours worth of minutes exactly', () => {
    expect(minutesToHoursTenths(60)).toBe(10); // 1h
    expect(minutesToHoursTenths(600)).toBe(100); // 10h
  });

  it('rounds to the nearest tenth of an hour (nearest 6 minutes)', () => {
    expect(minutesToHoursTenths(6)).toBe(1); // exactly 0.1h
    expect(minutesToHoursTenths(3)).toBe(1); // rounds up from 0.05h
    expect(minutesToHoursTenths(2)).toBe(0); // rounds down toward 0h
  });

  it('never produces a float — every result is a whole number of tenths', () => {
    for (const minutes of [1, 5, 7, 59, 91, 12_345]) {
      expect(Number.isInteger(minutesToHoursTenths(minutes))).toBe(true);
    }
  });

  it('matches a real large playtime figure (532.8h in the source data becomes 31968 minutes)', () => {
    expect(minutesToHoursTenths(31_968)).toBe(5328);
  });

  it('degrades non-finite or negative input to 0 rather than propagating NaN or a negative value', () => {
    expect(minutesToHoursTenths(Number.NaN)).toBe(0);
    expect(minutesToHoursTenths(-10)).toBe(0);
    expect(minutesToHoursTenths(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
