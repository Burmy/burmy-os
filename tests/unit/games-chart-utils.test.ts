import { describe, expect, it } from 'vitest';

import { categoryColor, computeChartDomain, formatAxisHours } from '@/features/games/dashboard/chart-utils';

describe('formatAxisHours', () => {
  it('renders whole hours compactly', () => {
    expect(formatAxisHours(5320)).toBe('532h');
  });

  it('renders zero as 0h rather than an empty label', () => {
    expect(formatAxisHours(0)).toBe('0h');
  });
});

describe('categoryColor', () => {
  it('cycles through the palette rather than running out', () => {
    expect(categoryColor(0)).toBe(categoryColor(16));
    expect(categoryColor(0)).not.toBe(categoryColor(1));
  });
});

describe('computeChartDomain', () => {
  it('always folds zero into the domain so bars share a baseline', () => {
    expect(computeChartDomain([500, 900])).toEqual([0, 900]);
  });

  it('pads a degenerate single-value domain instead of repeating one tick', () => {
    const [min, max] = computeChartDomain([100, 100]);
    expect(max).toBeGreaterThan(min);
  });

  it('handles an empty series without producing NaN', () => {
    const [min, max] = computeChartDomain([]);
    expect(Number.isFinite(min)).toBe(true);
    expect(Number.isFinite(max)).toBe(true);
  });
});
