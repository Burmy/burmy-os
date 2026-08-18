'use client';

import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { EmptyState } from '@/components/finance/empty-state';
import type { CategoryAmount } from '@/server/finance/dashboard';
import { formatPercent } from '@/components/finance/format-percent';
import { categoryColor, formatAxisDollars, formatTooltipDollars } from './chart-utils';

/**
 * Horizontal bar, not a donut — reads cleanly at any category count, unlike
 * a pie/donut which degrades badly past ~6 slices (the exact failure mode
 * the user asked to avoid). Rows are already sorted largest-first by
 * `buildCategoryBreakdown`.
 */
export function CategoryBreakdownChart({
  categories,
}: {
  readonly categories: readonly CategoryAmount[];
}): React.ReactElement {
  if (categories.length === 0) return <EmptyState>No spending recorded this month.</EmptyState>;

  const height = Math.max(120, categories.length * 34 + 20);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={[...categories]}
        layout="vertical"
        margin={{ top: 4, right: 48, left: 8, bottom: 4 }}
        barCategoryGap={8}
      >
        <XAxis type="number" hide tickFormatter={formatAxisDollars} />
        <YAxis
          type="category"
          dataKey="name"
          width={120}
          tick={{ fontSize: 12, fill: 'var(--color-foreground)' }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          formatter={(value, _name, item) => {
            const percent = (item?.payload as CategoryAmount | undefined)?.percentOfExpenses ?? 0;
            return [`${formatTooltipDollars(Number(value))} (${formatPercent(percent)})`, 'Spent'];
          }}
          contentStyle={{
            background: 'var(--color-popover)',
            color: 'var(--color-popover-foreground)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            fontSize: 13,
          }}
        />
        <Bar dataKey="amountCents" radius={[0, 3, 3, 0]} maxBarSize={22}>
          {categories.map((category, index) => (
            <Cell key={category.categoryId ?? 'uncategorized'} fill={categoryColor(index)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
