import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DistributionChart } from '@/features/games/dashboard/charts/distribution-chart';
import type { DistributionSlice } from '@/server/games/stats';

function slice(key: string, count: number): DistributionSlice {
  return { key, label: key, count, percent: count };
}

/**
 * The genre chart used to render one bar per genre COMBINATION with no cap
 * and no height ceiling — `height={slices.length * 32 + 20}`, unbounded —
 * which is what turned a 180-game library into a chart thousands of pixels
 * tall. `DistributionChart` now caps at `MAX_CHART_SLICES` regardless of
 * what it's handed, independently of `buildGenreDistribution`'s own cap, so
 * no future distribution can reproduce that blow-up.
 *
 * Recharts' `ResponsiveContainer` needs real layout measurement to render
 * its chart body, which jsdom cannot provide (no `ResizeObserver` callback,
 * `getBoundingClientRect` always zero) — see `tests/setup/testing-library.ts`.
 * The wrapping `.recharts-responsive-container` div is rendered unconditionally
 * though, with the exact `height` prop `DistributionChart` computed, so
 * asserting on it is a real, unmocked test of the sizing math rather than a
 * trivial "did it throw" check.
 */
describe('DistributionChart', () => {
  it('renders the empty message and no chart when there are no slices', () => {
    render(<DistributionChart slices={[]} emptyMessage="No data yet." />);
    expect(screen.getByText('No data yet.')).toBeInTheDocument();
  });

  it('sizes the chart proportionally to the slice count when under the cap', () => {
    const slices = [slice('a', 3), slice('b', 2), slice('c', 1), slice('d', 1), slice('e', 1)];
    const { container } = render(<DistributionChart slices={slices} emptyMessage="—" />);
    const responsiveContainer = container.querySelector('.recharts-responsive-container');
    // 5 slices, none capped: 5 * 32 + 20 = 180.
    expect((responsiveContainer as HTMLElement | null)?.style.height).toBe('180px');
  });

  it('caps the rendered chart at 8 slices plus one "Other" bucket, however many are passed in', () => {
    // 50 slices is the shape the old genre-COMBINATION bug produced — one bar
    // per combination, dozens of them. Uncapped, this would size for all 50
    // (50 * 32 + 20 = 1620px); capped, it sizes for 8 + "Other" = 9.
    const slices = Array.from({ length: 50 }, (_unused, i) => slice(`g${i}`, 50 - i));
    const { container } = render(<DistributionChart slices={slices} emptyMessage="—" />);
    const responsiveContainer = container.querySelector('.recharts-responsive-container');
    expect((responsiveContainer as HTMLElement | null)?.style.height).toBe('308px');
  });
});
