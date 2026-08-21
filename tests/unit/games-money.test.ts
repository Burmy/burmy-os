import { describe, expect, it } from 'vitest';

import { formatPriceCents } from '@/server/games/money';

describe('formatPriceCents', () => {
  it('formats whole dollars with two decimal places', () => {
    expect(formatPriceCents(5999)).toBe('$59.99');
  });

  it('formats zero without a sign', () => {
    expect(formatPriceCents(0)).toBe('$0.00');
  });

  it('rounds a computed average to the nearest cent', () => {
    // 100 / 3 = 33.333... cents — a real shape for an averaged figure.
    expect(formatPriceCents(100 / 3)).toBe('$0.33');
  });

  it('never prints a negative-zero dollar amount', () => {
    // Object.is distinguishes -0 from 0; a naive `cents === 0 ? 0 : cents`
    // guard elsewhere in this codebase (finance/grid.ts) exists for exactly
    // this shape of bug from unary negation or a rounded near-zero average.
    expect(formatPriceCents(-0.2)).toBe('$0.00');
    expect(formatPriceCents(-0.2)).not.toBe('$-0.00');
  });
});
