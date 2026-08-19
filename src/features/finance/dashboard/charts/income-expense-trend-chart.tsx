'use client';

import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { EmptyState } from '@/components/finance/empty-state';
import type { TrendPoint } from '@/server/finance/dashboard';
import { computeChartDomain, formatAxisDollars, formatTooltipDollars } from './chart-utils';

/**
 * Income vs Expenses, trailing months ending at the owner's most recent
 * data — always shows the broad multi-month picture, independent of which
 * month is selected below it.
 *
 * `type="linear"` (straight segments), not `"monotone"` — a smooth curve
 * through mostly-zero surrounding points bulges into a bell shape around
 * the one real month, visually implying a gradual ramp up and down that
 * never happened. Straight segments show exactly what the data says: flat
 * at zero, then a real jump.
 */
export function IncomeExpenseTrendChart({ points }: { readonly points: readonly TrendPoint[] }): React.ReactElement {
  if (points.length === 0) return <EmptyState>Not enough history yet for a trend.</EmptyState>;

  const domain = computeChartDomain(points.flatMap((p) => [p.incomeCents, p.expenseCents]));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={points} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
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
        <Line type="linear" dataKey="incomeCents" name="Income" stroke="var(--color-chart-income)" strokeWidth={2} dot={{ r: 3 }} />
        <Line type="linear" dataKey="expenseCents" name="Expenses" stroke="var(--color-chart-expense)" strokeWidth={2} dot={{ r: 3 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}
