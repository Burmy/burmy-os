'use client';

import { useState } from 'react';

import { formatPercent } from '@/components/finance/format-percent';
import { FilterBar, FilterField } from '@/components/ui/filter-bar';
import { PageHeader } from '@/components/ui/page-header';
import { SegmentedToggle } from '@/components/ui/segmented-toggle';
import { Section } from '@/components/ui/section';
import { StatCard } from '@/components/ui/stat-card';
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
    <div className="space-y-8">
      {/* The header carries only page ACTIONS and the display-mode toggle.
          The period picker is a FILTER — it changes which data the page
          shows — so it lives in the filter row below, exactly where
          Transactions puts its own Year/Month selects. Placement is decided
          by what a control does, not by which page it happens to be on;
          this used to be the app's most visible inconsistency (Monthly's
          period picker top-right, Transactions' identical one underneath). */}
      <PageHeader title="Finance" actions={actions} />

      {/* Every CONTROL lives on this one row; the header keeps only the
          page's primary action. Filters sit left, the display-mode toggle
          right — it isn't a filter (it changes how the same data is shown,
          not which data), so it reads as distinct while still living with
          the other controls instead of floating up beside the title. */}
      <FilterBar className="justify-between">
        <FilterField label={view === 'year' ? 'Year' : 'Period'}>
          <MonthNavigator year={year} month={month} years={years} mode={view} />
        </FilterField>

        <SegmentedToggle
          value={view}
          onChange={setView}
          options={[
            { value: 'month', label: 'Month' },
            { value: 'year', label: 'This Year' },
          ]}
        />
      </FilterBar>

      {view === 'month' ? (
        <div className="space-y-8">
          <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 xl:grid-cols-6">
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

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <Section title="Income vs Expenses" description="Most recent months of activity">
              <IncomeExpenseTrendChart points={trend} />
            </Section>
            <Section title="Net cash flow" description="Income minus expenses, per month">
              <NetCashflowChart points={trend} />
            </Section>
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <Section title="Spending by category" description="Selected month, largest first">
              <CategoryBreakdownChart categories={categoryBreakdown} />
            </Section>
            <Section title="Category trends" description="Top categories, trailing months">
              <CategoryTrendChart series={categoryTrend} />
            </Section>
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

          <Section title="Largest expenses this month">
            <LargestExpensesList expenses={topExpenses} year={year} month={month} />
          </Section>
        </div>
      ) : (
        <div className="space-y-8">
          <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 xl:grid-cols-5">
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

          <Section
            title={`${ytd.summary.year} income vs expenses`}
            description={isCompletedYear ? 'Every month this year' : 'Every month so far this year'}
          >
            <IncomeExpenseTrendChart points={ytd.trend} />
          </Section>

          <Section title="Yearly breakdown" description="Why one month cost more than another — Jan through Dec">
            <YearlyBreakdownChart breakdown={ytd.yearlyBreakdown} />
          </Section>

          <Section title="Spending by category" description={`${ytd.summary.year}, largest first`}>
            <AnnualCategoryChart categories={ytd.annualCategories} totalCents={ytd.summary.expenseCents} />
          </Section>
        </div>
      )}
    </div>
  );
}
