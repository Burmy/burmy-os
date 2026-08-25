'use client';

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { EmptyState } from '@/components/finance/empty-state';
import { TOOLTIP_STYLES } from '@/components/ui/chart-utils';
import type { TrendPoint } from '@/server/finance/dashboard';
import { computeChartDomain, formatAxisDollars, formatTooltipDollars } from './chart-utils';

/** `Income − Expenses` per month — positive (favorable) months in green, negative months in red, same trailing window as the trend chart above it. */
export function NetCashflowChart({ points }: { readonly points: readonly TrendPoint[] }): React.ReactElement {
  if (points.length === 0) return <EmptyState>Not enough history yet for a trend.</EmptyState>;

  // Explicit domain — see `computeChartDomain`'s own doc comment for why:
  // without it, a single populated month (or an otherwise flat series)
  // makes Recharts print the same Y-axis label 4-5 times instead of a scale.
  const domain = computeChartDomain(points.map((p) => p.netCents));

  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={points} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
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
        <Tooltip formatter={(value) => formatTooltipDollars(Number(value))} {...TOOLTIP_STYLES} />
        <Bar dataKey="netCents" name="Net" radius={[3, 3, 3, 3]}>
          {points.map((point) => (
            <Cell
              key={`${point.year}-${point.month}`}
              fill={point.netCents >= 0 ? 'var(--color-chart-income)' : 'var(--color-chart-net-negative)'}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
