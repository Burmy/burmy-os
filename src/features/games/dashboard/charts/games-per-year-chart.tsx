'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import type { YearlyBreakdownRow } from '@/server/games/stats';
import { TOOLTIP_STYLES, computeChartDomain } from '../chart-utils';

export function GamesPerYearChart({
  rows,
}: {
  readonly rows: readonly YearlyBreakdownRow[];
}): React.ReactElement {
  if (rows.length === 0) {
    return <p className="text-muted-foreground py-12 text-center text-sm">No years with games yet.</p>;
  }

  // Oldest-first reads correctly on a time axis, even though the table below
  // is newest-first (a table is scanned, an axis is read left to right).
  const data = [...rows].sort((a, b) => a.year - b.year);

  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
        <XAxis dataKey="year" tick={{ fontSize: 12, fill: 'var(--color-muted-foreground)' }} tickLine={false} axisLine={false} />
        <YAxis
          domain={computeChartDomain(data.map((row) => row.gameCount))}
          tick={{ fontSize: 12, fill: 'var(--color-muted-foreground)' }}
          tickLine={false}
          axisLine={false}
          width={56}
        />
        <Tooltip formatter={(value) => [String(value), 'Games']} {...TOOLTIP_STYLES} />
        <Bar dataKey="gameCount" fill="var(--color-chart-cat-2)" radius={[3, 3, 0, 0]} maxBarSize={40} />
      </BarChart>
    </ResponsiveContainer>
  );
}
