'use client';

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { TOOLTIP_STYLES } from '@/components/ui/chart-utils';
import type { YearlyBreakdownRow } from '@/server/games/stats';
import { computeChartDomain } from '../chart-utils';

/**
 * A line, not a bar — the owner's original spreadsheet kept this as one of
 * three line charts (Games/Hours/Trophies vs Year), and a continuous year
 * axis reads as a trend on a line in a way a set of disconnected bars does
 * not. `type="linear"` (straight segments), matching Finance's own trend
 * charts: a smoothed curve through real year-over-year counts would imply a
 * gradual ramp between points that never happened.
 */
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
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
        <XAxis dataKey="year" tick={{ fontSize: 12, fill: 'var(--color-muted-foreground)' }} tickLine={false} axisLine={false} />
        <YAxis
          domain={computeChartDomain(data.map((row) => row.startedCount))}
          allowDecimals={false}
          tick={{ fontSize: 12, fill: 'var(--color-muted-foreground)' }}
          tickLine={false}
          axisLine={false}
          width={40}
        />
        <Tooltip formatter={(value) => [String(value), 'Games started']} {...TOOLTIP_STYLES} />
        <Line
          type="linear"
          dataKey="startedCount"
          name="Games started"
          stroke="var(--color-chart-cat-2)"
          strokeWidth={2}
          dot={{ r: 3 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
