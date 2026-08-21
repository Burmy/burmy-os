'use client';

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import type { YearlyBreakdownRow } from '@/server/games/stats';
import { TOOLTIP_STYLES, computeChartDomain } from '../chart-utils';

/**
 * Trophies (achievements unlocked) per year — the third of the owner's three
 * original spreadsheet line charts (Games/Hours/Trophies vs. Year), and
 * previously missing from the dashboard entirely. `YearlyBreakdownRow.achievements`
 * already sums `achievementsUnlocked` per year in `buildYearlyBreakdown`, so
 * this chart needs no new server-side aggregation.
 */
export function TrophiesPerYearChart({
  rows,
}: {
  readonly rows: readonly YearlyBreakdownRow[];
}): React.ReactElement {
  if (rows.length === 0) {
    return <p className="text-muted-foreground py-12 text-center text-sm">No years with achievements yet.</p>;
  }

  // Oldest-first reads correctly on a time axis, even though the table below
  // is newest-first (a table is scanned, an axis is read left to right).
  const data = [...rows].sort((a, b) => a.year - b.year);

  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
        <XAxis dataKey="year" tick={{ fontSize: 12, fill: 'var(--color-muted-foreground)' }} tickLine={false} axisLine={false} />
        <YAxis
          domain={computeChartDomain(data.map((row) => row.achievements))}
          allowDecimals={false}
          tick={{ fontSize: 12, fill: 'var(--color-muted-foreground)' }}
          tickLine={false}
          axisLine={false}
          width={40}
        />
        <Tooltip formatter={(value) => [String(value), 'Trophies']} {...TOOLTIP_STYLES} />
        <Line
          type="linear"
          dataKey="achievements"
          name="Trophies"
          stroke="var(--color-chart-cat-3)"
          strokeWidth={2}
          dot={{ r: 3 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
