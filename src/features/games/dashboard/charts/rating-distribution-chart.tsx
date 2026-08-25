'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { TOOLTIP_STYLES } from '@/components/ui/chart-utils';
import { type GameStatRow, buildDistribution } from '@/server/games/stats';
import { computeChartDomain } from '../chart-utils';

const RATING_VALUES = [1, 2, 3, 4, 5] as const;

/**
 * Five fixed 1★–5★ buckets, not the shared `DistributionChart` — that
 * component sorts by frequency (largest slice first) and drops zero-count
 * keys entirely, both wrong for rating: it is a closed 1-5 ordinal scale
 * (enforced by the schema), unlike genre/platform/ownership, which are
 * open-ended sets where dropping an absent key is exactly right. A library
 * with 3★ and 5★ games but no 4★ must still show 4★ as a real zero-count
 * bucket next to its neighbours, not skip straight from 3★ to 5★ as if they
 * were adjacent values.
 *
 * `buildDistribution` still does the counting and is left untouched here —
 * platform/ownership/genre correctly depend on it dropping zero-count keys,
 * so this component builds the five buckets itself and looks each one up,
 * defaulting to 0 when `buildDistribution` didn't emit it. Because the five
 * buckets are constructed in order, no re-sort is needed afterward.
 */
export function RatingDistributionChart({
  rows,
}: {
  readonly rows: readonly GameStatRow[];
}): React.ReactElement {
  const distribution = buildDistribution(
    rows,
    (row) => (row.rating === null ? null : String(row.rating)),
    (key) => `${key}★`,
  );

  if (distribution.length === 0) {
    return <p className="text-muted-foreground py-12 text-center text-sm">No ratings recorded yet.</p>;
  }

  const countByRating = new Map(distribution.map((slice) => [slice.key, slice.count]));
  const data = RATING_VALUES.map((value) => ({
    label: `${value}★`,
    count: countByRating.get(String(value)) ?? 0,
  }));

  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
        <XAxis dataKey="label" tick={{ fontSize: 12, fill: 'var(--color-muted-foreground)' }} tickLine={false} axisLine={false} />
        <YAxis
          domain={computeChartDomain(data.map((slice) => slice.count))}
          tick={{ fontSize: 12, fill: 'var(--color-muted-foreground)' }}
          tickLine={false}
          axisLine={false}
          width={40}
          allowDecimals={false}
        />
        <Tooltip formatter={(value) => [String(value), 'Games']} {...TOOLTIP_STYLES} />
        <Bar dataKey="count" fill="var(--color-chart-cat-4)" radius={[3, 3, 0, 0]} maxBarSize={40} />
      </BarChart>
    </ResponsiveContainer>
  );
}
