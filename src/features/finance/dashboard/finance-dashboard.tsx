'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { formatPercent } from '@/components/finance/format-percent';
import type { TopExpenseRow } from '@/server/db/finance/grid';
import { MONTH_ABBREVIATIONS } from '@/server/finance/grid';
import type {
  BiggestSpendingDay,
  CategoryAmount,
  CategoryTrendSeries,
  MonthComparison,
  MonthSummary,
  TrendPoint,
  YearlyBreakdown,
  YtdSummary,
} from '@/server/finance/dashboard';
import { cents, format } from '@/server/finance/money';
import { AnnualCategoryChart } from './charts/annual-category-chart';
import { CategoryBreakdownChart } from './charts/category-breakdown-chart';
import { CategoryTrendChart } from './charts/category-trend-chart';
import { IncomeExpenseTrendChart } from './charts/income-expense-trend-chart';
import { NetCashflowChart } from './charts/net-cashflow-chart';
import { YearlyBreakdownChart } from './charts/yearly-breakdown-chart';
import { ComparisonIndicator } from './comparison-indicator';
import { InsightsSection } from './insights-section';
import { LargestExpensesList } from './largest-expenses-list';
import { MonthNavigator } from './month-navigator';
import { StatCard } from './stat-card';

function ChartCard({
  title,
  subtitle,
  children,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="rounded-lg border bg-card p-5">
      <h2 className="text-sm font-medium">{title}</h2>
      {subtitle ? <p className="text-muted-foreground text-xs">{subtitle}</p> : null}
      <div className="mt-3">{children}</div>
    </div>
  );
}

export interface FinanceDashboardProps {
  readonly year: number;
  readonly month: number;
  readonly years: readonly number[];
  readonly isCurrentMonth: boolean;
  readonly previousMonthLabel: string;
  readonly actions: React.ReactNode;
  readonly summary: MonthSummary;
  readonly comparison: MonthComparison | null;
  readonly savingsRatePercent: number | null;
  readonly avgDailySpendingCents: number;
  readonly avgTransactionCents: number | null;
  readonly trend: readonly TrendPoint[];
  readonly categoryBreakdown: readonly CategoryAmount[];
  readonly categoryTrend: readonly CategoryTrendSeries[];
  readonly topExpenses: readonly TopExpenseRow[];
  readonly insights: {
    readonly largestExpense: TopExpenseRow | null;
    readonly topCategory: CategoryAmount | null;
    readonly biggestSpendingDay: BiggestSpendingDay | null;
    readonly highestIncomeMonth: MonthSummary | null;
    readonly highestSpendingMonth: MonthSummary | null;
    readonly bestNetMonth: MonthSummary | null;
  };
  readonly ytd: {
    readonly summary: YtdSummary;
    readonly trend: readonly TrendPoint[];
    readonly annualCategories: readonly CategoryAmount[];
    readonly yearlyBreakdown: YearlyBreakdown;
  };
}

/**
 * Top-level composition only — every number here arrives already computed
 * (`page.tsx` does the fetching and the pure-function calls, matching how it
 * already builds the M8 grid itself). This component's only own state is
 * the Month/This Year tab.
 */
export function FinanceDashboard({
  year,
  month,
  years,
  isCurrentMonth,
  previousMonthLabel,
  actions,
  summary,
  comparison,
  savingsRatePercent,
  avgDailySpendingCents,
  avgTransactionCents,
  trend,
  categoryBreakdown,
  categoryTrend,
  topExpenses,
  insights,
  ytd,
}: FinanceDashboardProps): React.ReactElement {
  const [view, setView] = useState<'month' | 'year'>('month');
  const isCompletedYear = ytd.summary.monthsElapsed >= 12;

  return (
    <div className="mt-4 space-y-4">
      {/* One toolbar: title, month/year navigation, Month/This Year mode, and
          the page-level actions (Transactions, Import statement) that used to
          sit in their own separate row above this one. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold">Finance</h1>
          <MonthNavigator year={year} month={month} years={years} mode={view} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border p-0.5">
            <Button
              type="button"
              size="sm"
              variant={view === 'month' ? 'secondary' : 'ghost'}
              className="h-7 px-2.5"
              onClick={() => setView('month')}
            >
              Month
            </Button>
            <Button
              type="button"
              size="sm"
              variant={view === 'year' ? 'secondary' : 'ghost'}
              className="h-7 px-2.5"
              onClick={() => setView('year')}
            >
              This Year
            </Button>
          </div>
          <div className="bg-border mx-1 hidden h-6 w-px sm:block" aria-hidden="true" />
          {actions}
        </div>
      </div>

      {view === 'month' ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <StatCard
              label="Income"
              // `summary.incomeCents` is already sign-flipped to a positive display
              // figure at the DB boundary (`getMonthlyTotalsAllTime`) — `formatInflow`
              // would flip it AGAIN and print it negative. `formatInflow` is for raw,
              // still-negative stored values (a single transaction row); this isn't one.
              value={format(cents(summary.incomeCents), { signed: true })}
              comparison={comparison ? <ComparisonIndicator comparison={comparison.income} previousLabel={previousMonthLabel} /> : null}
            />
            <StatCard
              label="Expenses"
              value={format(cents(summary.expenseCents))}
              comparison={comparison ? <ComparisonIndicator comparison={comparison.expense} previousLabel={previousMonthLabel} /> : null}
            />
            <StatCard
              label="Net"
              value={format(cents(summary.netCents), { signed: true })}
              comparison={comparison ? <ComparisonIndicator comparison={comparison.net} previousLabel={previousMonthLabel} /> : null}
              {...(summary.netCents < 0 ? { valueClassName: 'text-destructive' } : {})}
            />
            <StatCard
              label="Savings rate"
              value={savingsRatePercent === null ? '—' : formatPercent(savingsRatePercent)}
              {...(savingsRatePercent === null ? { hint: 'No income this month' } : {})}
            />
            <StatCard
              label="Avg. daily spending"
              value={format(cents(Math.round(avgDailySpendingCents)))}
              hint={isCurrentMonth ? 'So far this month' : 'Daily average'}
            />
            <StatCard label="Transactions" value={String(summary.transactionCount)} />
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <ChartCard title="Income vs Expenses" subtitle="Most recent months of activity">
              <IncomeExpenseTrendChart points={trend} />
            </ChartCard>
            <ChartCard title="Net cash flow" subtitle="Income minus expenses, per month">
              <NetCashflowChart points={trend} />
            </ChartCard>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <ChartCard title="Spending by category" subtitle="Selected month, largest first">
              <CategoryBreakdownChart categories={categoryBreakdown} />
            </ChartCard>
            <ChartCard title="Category trends" subtitle="Top categories, trailing months">
              <CategoryTrendChart series={categoryTrend} />
            </ChartCard>
          </div>

          <InsightsSection
            largestExpense={insights.largestExpense}
            topCategory={insights.topCategory}
            biggestSpendingDay={insights.biggestSpendingDay}
            spendingDayYear={year}
            spendingDayMonth={month}
            averageTransactionCents={avgTransactionCents}
            highestIncomeMonth={insights.highestIncomeMonth}
            highestSpendingMonth={insights.highestSpendingMonth}
            bestNetMonth={insights.bestNetMonth}
          />

          <div className="rounded-lg border bg-card p-5">
            <h2 className="text-sm font-medium">Largest expenses this month</h2>
            <div className="mt-3">
              <LargestExpensesList expenses={topExpenses} year={year} month={month} />
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            <StatCard
              label={isCompletedYear ? 'Income' : 'YTD Income'}
              value={format(cents(ytd.summary.incomeCents), { signed: true })}
            />
            <StatCard label={isCompletedYear ? 'Expenses' : 'YTD Expenses'} value={format(cents(ytd.summary.expenseCents))} />
            <StatCard
              label={isCompletedYear ? 'Net / Savings' : 'YTD Net'}
              value={format(cents(ytd.summary.netCents), { signed: true })}
              {...(ytd.summary.netCents < 0 ? { valueClassName: 'text-destructive' } : {})}
            />
            <StatCard
              label="Avg. monthly expenses"
              value={format(cents(Math.round(ytd.summary.averageMonthlyExpenseCents)))}
            />
            <StatCard
              label={isCompletedYear ? 'Savings rate' : 'YTD savings rate'}
              value={ytd.summary.savingsRatePercent === null ? '—' : formatPercent(ytd.summary.savingsRatePercent)}
              {...(ytd.summary.savingsRatePercent === null ? { hint: 'No income yet' } : {})}
            />
          </div>

          {ytd.summary.highestSpendingMonth ? (
            <p className="text-muted-foreground text-sm">
              Highest-spending month:{' '}
              <span className="text-foreground font-medium">
                {format(cents(ytd.summary.highestSpendingMonth.expenseCents))}
              </span>{' '}
              in {MONTH_ABBREVIATIONS[ytd.summary.highestSpendingMonth.month - 1]} {ytd.summary.year}
            </p>
          ) : null}

          <ChartCard
            title={`${ytd.summary.year} income vs expenses`}
            subtitle={isCompletedYear ? 'Every month this year' : 'Every month so far this year'}
          >
            <IncomeExpenseTrendChart points={ytd.trend} />
          </ChartCard>

          <ChartCard title="Yearly breakdown" subtitle="Why one month cost more than another — Jan through Dec">
            <YearlyBreakdownChart breakdown={ytd.yearlyBreakdown} />
          </ChartCard>

          <ChartCard title="Spending by category" subtitle={`${ytd.summary.year}, largest first`}>
            <AnnualCategoryChart categories={ytd.annualCategories} totalCents={ytd.summary.expenseCents} />
          </ChartCard>
        </div>
      )}
    </div>
  );
}
