import { describe, expect, it } from 'vitest';

import {
  MoneyError,
  ZERO,
  abs,
  add,
  allocate,
  allocateEvenly,
  cents,
  compare,
  equals,
  format,
  formatInflow,
  fromDb,
  isInflow,
  isOutflow,
  isZero,
  multiply,
  negate,
  parseDebitCredit,
  parseMoney,
  subtract,
  sum,
  toDb,
  toDecimalString,
} from '../../src/server/finance/money';

describe('cents()', () => {
  it('accepts safe integers including negatives and zero', () => {
    expect(cents(0)).toBe(0);
    expect(cents(1234)).toBe(1234);
    expect(cents(-1234)).toBe(-1234);
  });

  it('rejects non-integers — a fractional cent is always a bug', () => {
    expect(() => cents(12.5)).toThrow(MoneyError);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => cents(Number.NaN)).toThrow(MoneyError);
    expect(() => cents(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
  });

  it('rejects values beyond the safe integer range', () => {
    expect(() => cents(Number.MAX_SAFE_INTEGER + 2)).toThrow(MoneyError);
  });
});

describe('parseMoney()', () => {
  it.each([
    ['12.34', 1234],
    ['0.01', 1],
    ['0.99', 99],
    ['1.00', 100],
    ['1234.56', 123456],
    ['0', 0],
    ['0.00', 0],
  ])('parses plain decimals: %s -> %i', (input, expected) => {
    expect(parseMoney(input)).toBe(expected);
  });

  it.each([
    ['-12.34', -1234],
    ['+12.34', 1234],
    ['(12.34)', -1234],
    ['(1,234.56)', -123456],
  ])('parses signs including accounting parentheses: %s -> %i', (input, expected) => {
    expect(parseMoney(input)).toBe(expected);
  });

  it.each([
    ['$12.34', 1234],
    ['-$1,234.56', -123456],
    ['$ 1,234.56', 123456],
    ['  $1,234.56  ', 123456],
    ['1,234,567.89', 123456789],
  ])('parses currency symbols, separators and whitespace: %s -> %i', (input, expected) => {
    expect(parseMoney(input)).toBe(expected);
  });

  it.each([
    ['1234', 123400],
    ['1234.', 123400],
    ['.5', 50],
    ['.50', 50],
    ['12.3', 1230],
  ])('handles missing or partial decimal parts: %s -> %i', (input, expected) => {
    expect(parseMoney(input)).toBe(expected);
  });

  it('handles non-breaking spaces, which appear in copied/pasted bank data', () => {
    // U+00A0 and U+202F look identical to a normal space but are different
    // characters. A literal " " character class silently misses them, so this
    // pins the behaviour rather than trusting it to a later .trim().
    expect(parseMoney('$ 1,234.56')).toBe(123456);
    expect(parseMoney('-$ 12.34')).toBe(-1234);
    expect(parseMoney(' 12.34 ')).toBe(1234);
    expect(parseMoney('1 234.56')).toBe(123456);
  });

  it('REFUSES to round silently when given more than two decimals', () => {
    // Rounding a bank figure without being asked is exactly the quiet
    // corruption this project exists to prevent.
    expect(() => parseMoney('12.345')).toThrow(/refusing to round silently/);
  });

  it.each(['', '   ', 'abc', '$', '12.34.56', '1.2.3', '--12.34', '12a.34'])(
    'rejects malformed input: %s',
    (input) => {
      expect(() => parseMoney(input)).toThrow(MoneyError);
    },
  );

  it('rejects an ambiguous double negative', () => {
    expect(() => parseMoney('(-12.34)')).toThrow(/double negative/);
  });

  it('names the offending value in the error, for import diagnostics', () => {
    expect(() => parseMoney('nope')).toThrow(/"nope"/);
  });
});

describe('parseDebitCredit()', () => {
  it('treats a debit as an OUTFLOW (positive), per Burmy convention', () => {
    expect(parseDebitCredit('82.17', null)).toBe(8217);
    expect(parseDebitCredit('82.17', '')).toBe(8217);
  });

  it('treats a credit as an INFLOW (negative)', () => {
    expect(parseDebitCredit(null, '82.17')).toBe(-8217);
  });

  it('normalizes signs the bank may already have applied', () => {
    // Some exports put a minus in the debit column as well; magnitude wins.
    expect(parseDebitCredit('-82.17', null)).toBe(8217);
    expect(parseDebitCredit(null, '-82.17')).toBe(-8217);
  });

  it('fails loudly when both columns are populated', () => {
    expect(() => parseDebitCredit('10.00', '10.00')).toThrow(/both debit .* and credit/);
  });

  it('fails loudly when neither column is populated', () => {
    expect(() => parseDebitCredit(null, null)).toThrow(/neither debit nor credit/);
    expect(() => parseDebitCredit('', '   ')).toThrow(/neither debit nor credit/);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts exactly', () => {
    expect(add(cents(1999), cents(1))).toBe(2000);
    expect(subtract(cents(2000), cents(1))).toBe(1999);
  });

  it('negates and takes absolute value', () => {
    expect(negate(cents(1234))).toBe(-1234);
    expect(negate(cents(-1234))).toBe(1234);
    expect(abs(cents(-1234))).toBe(1234);
    expect(negate(ZERO)).toBe(0);
  });

  it('sums an empty list to zero', () => {
    expect(sum([])).toBe(0);
  });

  it('sums mixed signs — the reimbursement case', () => {
    // Food, August: $60.00 dinner, $30.00 reimbursement, $59.14 groceries.
    const total = sum([cents(6000), cents(-3000), cents(5914)]);
    expect(total).toBe(8914);
    expect(format(total)).toBe('$89.14');
  });

  it('has no floating-point drift across many additions', () => {
    // 0.1 + 0.2 !== 0.3 in floats. In cents it is simply 10 + 20 === 30.
    const values = Array.from({ length: 1000 }, () => cents(10));
    expect(sum(values)).toBe(10_000);
    expect(add(cents(10), cents(20))).toBe(30);
  });

  it('multiplies by integer counts only', () => {
    expect(multiply(cents(1999), 3)).toBe(5997);
    expect(() => multiply(cents(1999), 0.5)).toThrow(/must be an integer/);
  });
});

describe('negative zero is never produced', () => {
  // JS yields -0 from ordinary arithmetic, and -0 === 0 is TRUE, so it hides
  // from casual comparison while still being distinguishable by Object.is,
  // Map/Set keys, and some serializers. A negative zero dollars is meaningless.
  const isNegZero = (v: number) => Object.is(v, -0);

  it('never comes out of a single operation', () => {
    expect(isNegZero(negate(ZERO))).toBe(false);
    expect(isNegZero(abs(ZERO))).toBe(false);
    expect(isNegZero(cents(-0))).toBe(false);
    expect(isNegZero(multiply(ZERO, -5))).toBe(false);
    expect(isNegZero(multiply(cents(-5), 0))).toBe(false);
    expect(isNegZero(add(cents(-100), cents(100)))).toBe(false);
    expect(isNegZero(subtract(cents(100), cents(100)))).toBe(false);
    expect(isNegZero(sum([cents(-100), cents(100)]))).toBe(false);
    expect(isNegZero(parseMoney('-0.00'))).toBe(false);
    expect(isNegZero(parseMoney('(0.00)'))).toBe(false);
  });

  it('never comes out of allocation, including negative totals', () => {
    for (const part of allocate(ZERO, [1, 2, 3])) {
      expect(isNegZero(part)).toBe(false);
    }
    // A negative total with a zero weight is the case that produces -0 naively.
    for (const part of allocate(cents(-100), [1, 0, 1])) {
      expect(isNegZero(part)).toBe(false);
    }
  });

  it('survives the database round trip', () => {
    expect(isNegZero(fromDb('-0'))).toBe(false);
    expect(isNegZero(fromDb(-0))).toBe(false);
  });

  it('formats as a plain zero', () => {
    expect(format(negate(ZERO))).toBe('$0.00');
    expect(toDecimalString(negate(ZERO))).toBe('0.00');
  });
});

describe('comparison', () => {
  it('classifies direction by sign — positive is money leaving', () => {
    expect(isOutflow(cents(1))).toBe(true);
    expect(isInflow(cents(-1))).toBe(true);
    expect(isZero(ZERO)).toBe(true);
    expect(isOutflow(ZERO)).toBe(false);
    expect(isInflow(ZERO)).toBe(false);
  });

  it('compares and sorts', () => {
    expect(equals(cents(100), cents(100))).toBe(true);
    expect(compare(cents(-100), cents(100))).toBe(-1);
    expect(compare(cents(100), cents(100))).toBe(0);
    expect([cents(300), cents(-100), cents(200)].sort(compare)).toEqual([-100, 200, 300]);
  });
});

describe('allocate()', () => {
  it('splits exactly — children always sum to the parent', () => {
    // The Amazon split from the spec: $104.82 across four categories.
    const total = cents(10482);
    const parts = allocate(total, [5299, 1799, 2185, 1199]);
    expect(sum(parts)).toBe(total);
  });

  it('distributes the leftover cent rather than losing it', () => {
    // $1.00 in three ways cannot divide evenly: 34 + 33 + 33.
    const parts = allocateEvenly(cents(100), 3);
    expect(sum(parts)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
  });

  it('gives leftover cents to the largest remainders, ties broken by index', () => {
    // 10 cents by weights [1,1,1]: exact shares are 3.33 each, floors 3,3,3,
    // remainder 1 -> first index wins the tie.
    expect(allocate(cents(10), [1, 1, 1])).toEqual([4, 3, 3]);
  });

  it('is deterministic across repeated calls', () => {
    const a = allocate(cents(10_000), [7, 11, 13, 17]);
    const b = allocate(cents(10_000), [7, 11, 13, 17]);
    expect(a).toEqual(b);
  });

  it('handles negative totals (inflows) without skewing toward zero', () => {
    const total = cents(-100);
    const parts = allocate(total, [1, 1, 1]);
    expect(sum(parts)).toBe(total);
    expect(parts).toEqual([-34, -33, -33]);
  });

  it('handles zero-weight participants', () => {
    const parts = allocate(cents(1000), [1, 0, 1]);
    expect(sum(parts)).toBe(1000);
    expect(parts[1]).toBe(0);
  });

  it('handles a single participant', () => {
    expect(allocate(cents(1234), [1])).toEqual([1234]);
  });

  it('allocates zero to zero', () => {
    const parts = allocate(ZERO, [1, 2, 3]);
    expect(sum(parts)).toBe(0);
    expect(parts).toEqual([0, 0, 0]);
  });

  it('sums exactly across a wide range of awkward totals', () => {
    for (let total = 0; total <= 500; total++) {
      for (const weights of [[1, 1, 1], [1, 2, 3], [5299, 1799, 2185, 1199], [7, 7, 7, 7, 7]]) {
        const parts = allocate(cents(total), weights);
        expect(sum(parts)).toBe(total);
      }
    }
  });

  it('rejects invalid weights', () => {
    expect(() => allocate(cents(100), [])).toThrow(/must not be empty/);
    expect(() => allocate(cents(100), [0, 0])).toThrow(/must not sum to zero/);
    expect(() => allocate(cents(100), [1, -1])).toThrow(/non-negative/);
    expect(() => allocateEvenly(cents(100), 0)).toThrow(/positive integer/);
  });
});

describe('formatting', () => {
  it('formats unsigned by default — the grid shows spending as a plain figure', () => {
    expect(format(cents(6000))).toBe('$60.00');
    expect(format(cents(-6000))).toBe('$60.00');
    expect(format(cents(201900))).toBe('$2,019.00');
    expect(format(ZERO)).toBe('$0.00');
  });

  it('formats signed where direction matters', () => {
    expect(format(cents(-3000), { signed: true })).toBe('-$30.00');
    expect(format(cents(3000), { signed: true })).toBe('$30.00');
  });

  it('flips income for display without touching the stored value', () => {
    // Income is STORED negative (money arriving) but must READ positive.
    const storedPaycheck = cents(-640_000);
    expect(formatInflow(storedPaycheck)).toBe('$6,400.00');
    expect(storedPaycheck).toBe(-640_000);
  });

  it('renders a plain decimal string for exports', () => {
    expect(toDecimalString(cents(123456))).toBe('1234.56');
    expect(toDecimalString(cents(-123456))).toBe('-1234.56');
    expect(toDecimalString(cents(5))).toBe('0.05');
    expect(toDecimalString(ZERO)).toBe('0.00');
  });

  it('round-trips through parseMoney', () => {
    for (const value of [0, 1, 99, 100, 123456, -123456, 999_999_99]) {
      expect(parseMoney(toDecimalString(cents(value)))).toBe(value);
    }
  });
});

describe('database boundary', () => {
  it('accepts number, string and bigint from the driver', () => {
    expect(fromDb(1234)).toBe(1234);
    expect(fromDb('1234')).toBe(1234);
    expect(fromDb(' -1234 ')).toBe(-1234);
    expect(fromDb(1234n)).toBe(1234);
  });

  it('rejects null rather than silently coercing to zero', () => {
    // A missing amount must surface, not quietly become $0.00.
    expect(() => fromDb(null)).toThrow(MoneyError);
    expect(() => fromDb(undefined)).toThrow(MoneyError);
  });

  it('rejects a decimal string — that would mean the column is not BIGINT', () => {
    expect(() => fromDb('12.34')).toThrow(/integer string of cents/);
  });

  it('rejects a bigint beyond the safe range', () => {
    expect(() => fromDb(BigInt(Number.MAX_SAFE_INTEGER) + 10n)).toThrow(/safe integer range/);
  });

  it('round-trips to and from the database', () => {
    expect(fromDb(toDb(cents(-8914)))).toBe(-8914);
  });
});
