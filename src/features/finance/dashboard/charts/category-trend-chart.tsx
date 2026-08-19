'use client';

import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { EmptyState } from '@/components/finance/empty-state';
import type { CategoryTrendSeries } from '@/server/finance/dashboard';
import { categoryColor, computeChartDomain, formatAxisDollars, formatTooltipDollars } from './chart-utils';

/**
 * Top categories over the trailing window, one line each — `series` share
 * one x-axis (`buildCategoryTrend` zero-fills every series against the same
 * month list), so this just pivots them into recharts' one-row-per-month
 * shape: `{ label, [categoryName]: amountCents }`.
 *
 * `type="linear"`, not `"monotone"` — see `IncomeExpenseTrendChart`'s note:
 * a smooth curve through mostly-zero neighbors around one real month reads
 * as a gradual ramp that never happened.
 */
export function CategoryTrendChart({
  series,
}: {
  readonly series: readonly CategoryTrendSeries[];
}): React.ReactElement {
  if (series.length === 0 || series[0]!.points.length === 0) {
    return <EmptyState>Not enough history yet for category trends.</EmptyState>;
  }

  // Keyed by `categoryId`, not `name` — two categories could share a display
  // name, and only the id is guaranteed unique, so that's what must key each
  // line's data to avoid silently merging two different categories.
  const seriesKey = (s: CategoryTrendSeries): string => s.categoryId ?? 'uncategorized';

  const data = series[0]!.points.map((point, pointIndex) => {
    const row: Record<string, string | number> = { label: point.label };
    for (const s of series) {
      row[seriesKey(s)] = s.points[pointIndex]?.amountCents ?? 0;
    }
    return row;
  });

  const domain = computeChartDomain(series.flatMap((s) => s.points.map((p) => p.amountCents)));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 12, fill: 'var(--color-muted-foreground)' }} tickLine={false} axisLine={false} />
        <YAxis
          domain={domain}
          tick={{ fontSize: 12, fill: 'var(--color-muted-foreground)' }}
          tickLine={false}
          axisLine={false}
          tickFormatter={formatAxisDollars}
          width={56}
        />
        <Tooltip
          formatter={(value) => formatTooltipDollars(Number(value))}
          contentStyle={{
            background: 'var(--color-popover)',
            color: 'var(--color-popover-foreground)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            fontSize: 13,
          }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {series.map((s, index) => (
          <Line
            key={seriesKey(s)}
            type="linear"
            dataKey={seriesKey(s)}
            name={s.name}
            stroke={categoryColor(index)}
            strokeWidth={2}
            dot={{ r: 2.5 }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
