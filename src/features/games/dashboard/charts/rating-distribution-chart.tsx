'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { type GameStatRow, buildDistribution } from '@/server/games/stats';
import { TOOLTIP_STYLES, computeChartDomain } from '../chart-utils';

/**
 * Five fixed 1★–5★ buckets, not the shared `DistributionChart` — that
 * component sorts by frequency (largest slice first), which would scramble a
 * rating scale that has to read 1→5 left to right instead. `buildDistribution`
 * still does the counting; this component re-sorts its output ascending by
 * the numeric rating before charting it.
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

  const data = [...distribution].sort((a, b) => Number(a.key) - Number(b.key));

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
