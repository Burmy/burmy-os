'use client';

import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

import { EmptyState } from '@/components/finance/empty-state';
import { formatPercent } from '@/components/finance/format-percent';
import type { CategoryAmount } from '@/server/finance/dashboard';
import { cents, format } from '@/server/finance/money';
import { categoryColor, formatTooltipDollars } from './chart-utils';
import { CategoryBreakdownChart } from './category-breakdown-chart';

/** Above this many categories a donut turns into confetti — fall back to the same horizontal bar the monthly view already uses, not a second unreadable chart type. */
const DONUT_MAX_CATEGORIES = 7;

/**
 * The year's spending by category — a donut with the annual total in the
 * center when the category count is manageable, otherwise the exact same
 * horizontal bar `CategoryBreakdownChart` already renders for the monthly
 * view (one component, two data windows, not two chart implementations).
 */
export function AnnualCategoryChart({
  categories,
  totalCents,
}: {
  readonly categories: readonly CategoryAmount[];
  readonly totalCents: number;
}): React.ReactElement {
  if (categories.length === 0) return <EmptyState>No expenses recorded this year.</EmptyState>;
  if (categories.length > DONUT_MAX_CATEGORIES) return <CategoryBreakdownChart categories={categories} />;

  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={320}>
        <PieChart>
          <Pie
            data={[...categories]}
            dataKey="amountCents"
            nameKey="name"
            innerRadius="55%"
            outerRadius="85%"
            paddingAngle={2}
            strokeWidth={0}
          >
            {categories.map((category, index) => (
              <Cell key={category.categoryId ?? 'uncategorized'} fill={categoryColor(index)} />
            ))}
          </Pie>
          <Tooltip
            formatter={(value, _name, item) => {
              const payload = item?.payload as CategoryAmount | undefined;
              const percent = payload?.percentOfExpenses ?? 0;
              return [`${formatTooltipDollars(Number(value))} (${formatPercent(percent)})`, payload?.name ?? ''];
            }}
            contentStyle={{
              background: 'var(--color-popover)',
              color: 'var(--color-popover-foreground)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              fontSize: 13,
            }}
            // Recharts defaults each item's text to the series' own fill
            // color, not guaranteed readable against the popover background.
            itemStyle={{ color: 'var(--color-popover-foreground)' }}
            labelStyle={{ color: 'var(--color-popover-foreground)' }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
        </PieChart>
      </ResponsiveContainer>

      {/* Recharts has no built-in donut center label — overlaying plain text on
          top of the ResponsiveContainer is the standard, version-stable way. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center pb-8">
        <span className="text-muted-foreground text-xs">Total Expenses</span>
        <span className="tabular text-lg font-semibold">{format(cents(totalCents))}</span>
      </div>
    </div>
  );
}
