'use client';

import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { TOOLTIP_STYLES, categoryColor } from '@/components/ui/chart-utils';
import type { DistributionSlice } from '@/server/games/stats';

/**
 * Horizontal bars, not a donut — a donut degrades badly past ~6 slices, and
 * genre counts routinely exceed that.
 */
export function DistributionChart({
  slices,
  emptyMessage,
}: {
  readonly slices: readonly DistributionSlice[];
  readonly emptyMessage: string;
}): React.ReactElement {
  if (slices.length === 0) {
    return <p className="text-muted-foreground py-12 text-center text-sm">{emptyMessage}</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={Math.max(120, slices.length * 32 + 20)}>
      <BarChart data={[...slices]} layout="vertical" margin={{ top: 4, right: 40, left: 8, bottom: 4 }} barCategoryGap={8}>
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="label"
          width={110}
          tick={{ fontSize: 12, fill: 'var(--color-foreground)' }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          formatter={(value, _name, item) => {
            const percent = (item?.payload as DistributionSlice | undefined)?.percent ?? 0;
            return [`${value} (${percent.toFixed(0)}%)`, 'Games'];
          }}
          {...TOOLTIP_STYLES}
        />
        <Bar dataKey="count" radius={[0, 3, 3, 0]} maxBarSize={22}>
          {slices.map((slice, index) => (
            <Cell key={slice.key} fill={categoryColor(index)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
