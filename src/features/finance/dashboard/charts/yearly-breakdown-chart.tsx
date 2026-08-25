'use client';

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { TooltipContentProps } from 'recharts';

import { EmptyState } from '@/components/finance/empty-state';
import { categoryColor } from '@/components/ui/chart-utils';
import type { YearlyBreakdown } from '@/server/finance/dashboard';
import { computeChartDomain, formatAxisDollars, formatTooltipDollars } from './chart-utils';

const OTHER_KEY = '__other__';

// No explicit generic args — `TooltipContentProps` defaults to the same
// broad `ValueType`/`NameType` the bare `<Tooltip>` element itself expects
// when it isn't given explicit generics either; narrowing to `<number,
// string>` here made this function's type incompatible with `content={...}`.
function CustomTooltip({ active, payload, label }: TooltipContentProps): React.ReactElement | null {
  if (!active || !payload || payload.length === 0) return null;
  const nonZero = payload.filter((entry) => Number(entry.value ?? 0) > 0);
  const total = nonZero.reduce((sum, entry) => sum + Number(entry.value ?? 0), 0);
  if (nonZero.length === 0) return null;

  return (
    <div className="bg-popover text-popover-foreground min-w-40 rounded-md border p-2 text-xs shadow-sm">
      <div className="mb-1 font-medium">{label}</div>
      {[...nonZero].reverse().map((entry) => (
        <div key={String(entry.dataKey)} className="flex items-center justify-between gap-3 py-0.5">
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-2 rounded-full" style={{ background: entry.color }} />
            {entry.name}
          </span>
          <span className="tabular">{formatTooltipDollars(Number(entry.value ?? 0))}</span>
        </div>
      ))}
      <div className="mt-1 flex items-center justify-between border-t pt-1 font-medium">
        <span>Total</span>
        <span className="tabular">{formatTooltipDollars(total)}</span>
      </div>
    </div>
  );
}

/**
 * "Why was this month more expensive than another?" — one horizontal
 * stacked bar per calendar month, modeled directly on the owner's old
 * spreadsheet. The series set (`breakdown.series`) is fixed for the whole
 * year already, by `buildYearlyBreakdown` — this component just renders it
 * and colors "Other" distinctly (muted, not a real category color) so it
 * never gets mistaken for one.
 */
export function YearlyBreakdownChart({ breakdown }: { readonly breakdown: YearlyBreakdown }): React.ReactElement {
  const hasAnyData = breakdown.months.some((m) => m.totalCents > 0);
  if (!hasAnyData) return <EmptyState>No expenses recorded this year.</EmptyState>;

  const data = breakdown.months.map((m) => ({ label: m.label, ...m.segments }));
  const domain = computeChartDomain(breakdown.months.map((m) => m.totalCents));
  const height = Math.max(360, breakdown.months.length * 30 + 60);

  let colorIndex = 0;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }} barCategoryGap={6}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" horizontal={false} />
        <XAxis
          type="number"
          domain={domain}
          tick={{ fontSize: 12, fill: 'var(--color-muted-foreground)' }}
          tickLine={false}
          axisLine={false}
          tickFormatter={formatAxisDollars}
        />
        <YAxis
          type="category"
          dataKey="label"
          width={40}
          tick={{ fontSize: 12, fill: 'var(--color-foreground)' }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip content={CustomTooltip} cursor={{ fill: 'var(--color-muted)', opacity: 0.4 }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {breakdown.series.map((series) => {
          const isOther = series.key === OTHER_KEY;
          const fill = isOther ? 'var(--color-muted-foreground)' : categoryColor(colorIndex++);
          return <Bar key={series.key} dataKey={series.key} name={series.name} stackId="year" fill={fill} maxBarSize={20} />;
        })}
      </BarChart>
    </ResponsiveContainer>
  );
}
