import { describe, expect, it } from 'vitest';

import { computeChartDomain } from '@/features/finance/dashboard/charts/chart-utils';

describe('computeChartDomain', () => {
  it('always folds the zero baseline into the domain', () => {
    expect(computeChartDomain([500, 1200])).toEqual([0, 1200]);
    expect(computeChartDomain([-500, -1200])).toEqual([-1200, 0]);
  });

  it('a single positive data point spans [0, value], never a repeated flat tick', () => {
    const [min, max] = computeChartDomain([4300]);
    expect(min).toBe(0);
    expect(max).toBe(4300);
  });

  it('a single negative data point spans [value, 0] — the exact "-$43 repeated" bug this exists to fix', () => {
    const [min, max] = computeChartDomain([-4300]);
    expect(min).toBe(-4300);
    expect(max).toBe(0);
  });

  it('mixed positive and negative values span both', () => {
    expect(computeChartDomain([-2000, 3000, -500])).toEqual([-2000, 3000]);
  });

  it('all-zero data pads symmetrically instead of collapsing to a single tick', () => {
    const [min, max] = computeChartDomain([0, 0, 0]);
    expect(min).toBeLessThan(0);
    expect(max).toBeGreaterThan(0);
    expect(max).toBe(-min);
  });

  it('an empty values array behaves like all-zero data', () => {
    const [min, max] = computeChartDomain([]);
    expect(min).toBeLessThan(0);
    expect(max).toBeGreaterThan(0);
  });

  it('the pad scales with magnitude for a large single value, but has a floor for a small one', () => {
    const [bigMin] = computeChartDomain([-100000]);
    expect(bigMin).toBe(-100000); // real span already non-zero, no padding needed
    const [smallMin, smallMax] = computeChartDomain([0]);
    expect(smallMax - smallMin).toBeGreaterThanOrEqual(2000); // at least $10 each side
  });
});
