'use client';

import { useState } from 'react';

import { formatPercent } from '@/components/finance/format-percent';
import { FilterBar, FilterField } from '@/components/ui/filter-bar';
import { PageHeader } from '@/components/ui/page-header';
import { SegmentedToggle } from '@/components/ui/segmented-toggle';
import { Section } from '@/components/ui/section';
import { StatCard } from '@/components/ui/stat-card';
import { StatCardGrid } from '@/components/ui/stat-card-grid';
import type { TopExpenseRow } from '@/server/db/finance/grid';
import { formatHumanDate } from '@/lib/format-date';
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

/**
 * Whether the selected month's statements have all arrived — see
 * `AccountCoverage` in `server/finance/dashboard.ts` for the rule.
 *
 * `accounts` carries every account the rule is judged against, not just the ones
 * holding the month up, because "checking runs to Aug 15, card to Aug 27" is the
 * whole explanation; naming only the laggard would leave the owner wondering
 * about the other one.
 *
 * `dormant` carries the accounts `partitionCoverage` has written off. They are
 * listed too, and labelled — an account quietly dropped from the rule that
 * decides whether the dashboard renders is exactly the kind of thing that makes
 * the app unexplainable to the person who owns it.
 */
export interface MonthCoverage {
  readonly covered: boolean;
  /** ISO date every account has to reach for this month to be reportable. */
  readonly monthEnd: string;
  readonly accounts: readonly { readonly name: string; readonly latestDate: string }[];
  readonly dormant: readonly { readonly name: string; readonly latestDate: string }[];
}

export interface FinanceDashboardProps {
  readonly year: number;
  readonly month: number;
  readonly years: readonly number[];
  readonly coverage: MonthCoverage;
  readonly previousMonthLabel: string;
  readonly actions: React.ReactNode;
  readonly summary: MonthSummary;
  readonly comparison: MonthComparison | null;
  /** The same three metrics against a trailing 12-month average — see `compareToBaseline`. */
  readonly baseline: MonthComparison | null;
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
 * Sections inside a dashboard sit 20px apart — the same distance as the gap
 * BETWEEN cards in a `StatCardGrid`, so the whole page runs on one spacing
 * value instead of switching at every section boundary.
 *
 * The page-level rhythm ABOVE this (title -> filter row -> content) stays 32px.
 * That belongs to the shared page contract (`PageHeader`/`FilterBar`), not to
 * either dashboard, and separating a page's chrome from its content is a
 * different job from separating two blocks of that content.
 */
const SECTION_STACK = 'space-y-5';

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
  coverage,
  previousMonthLabel,
  actions,
  summary,
  comparison,
  baseline,
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
        <div className={SECTION_STACK}>
          {/* THE MONTH'S OWN NUMBERS ARE ALL-OR-NOTHING.
              Every card here, plus the category breakdown, the insights and
              the largest-expenses list further down, describes ONE month — and
              a month whose statements have not all arrived cannot honestly
              produce any of them. A savings rate computed from two weeks of
              card spending against a full month of income is not a smaller
              truth, it is a wrong number. So the whole block is replaced by an
              explanation of what is still missing.

              The trend charts in between are deliberately NOT gated: they are
              history rather than this month, and they already end at the last
              covered month (`dropUncoveredTail`), so the page still has
              something to show. */}
          {coverage.covered ? (
            <MonthStats
              summary={summary}
              comparison={comparison}
              baseline={baseline}
              previousMonthLabel={previousMonthLabel}
              savingsRatePercent={savingsRatePercent}
              avgDailySpendingCents={avgDailySpendingCents}
            />
          ) : (
            <MonthNotReady coverage={coverage} year={year} month={month} />
          )}

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <Section title="Income vs Expenses" description="Most recent months of activity">
              <IncomeExpenseTrendChart points={trend} />
            </Section>
            <Section title="Net cash flow" description="Income minus expenses, per month">
              <NetCashflowChart points={trend} />
            </Section>
          </div>

          {coverage.covered ? (
            <>
            <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
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
            </>
          ) : null}
        </div>
      ) : ytd.summary.monthsElapsed === 0 ? (
        // NOT A ROW OF $0.00 CARDS. No month of this year is covered yet, so
        // every annual figure would be a sum over nothing — and it would render
        // directly above a Full year grid showing real imported numbers, which
        // is precisely the contradiction this shipped with. Same decision as the
        // month view above: say what is missing instead of printing a zero.
        <YearNotReady year={ytd.summary.year} coverage={coverage} />
      ) : (
        <div className={SECTION_STACK}>
          <StatCardGrid>
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
          </StatCardGrid>

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

/**
 * The six headline cards. Extracted from the body only so the coverage branch
 * above reads as one decision — "these numbers, or an explanation of why there
 * are none" — instead of six conditionals threaded through the JSX.
 */
function MonthStats({
  summary,
  comparison,
  baseline,
  previousMonthLabel,
  savingsRatePercent,
  avgDailySpendingCents,
}: {
  readonly summary: MonthSummary;
  readonly comparison: MonthComparison | null;
  readonly baseline: MonthComparison | null;
  readonly previousMonthLabel: string;
  readonly savingsRatePercent: number | null;
  readonly avgDailySpendingCents: number;
}): React.ReactElement {
  return (
    <StatCardGrid>
      <StatCard
        label="Income"
        // `summary.incomeCents` is already sign-flipped to a positive display
        // figure at the DB boundary (`getMonthlyTotalsAllTime`) — `formatInflow`
        // would flip it AGAIN and print it negative. `formatInflow` is for raw,
        // still-negative stored values (a single transaction row); this isn't one.
        value={format(cents(summary.incomeCents), { signed: true })}
        comparison={
          // Stacked, not inline: two indicators side by side wrap
          // mid-phrase in a narrow stat card. Last month first, because
          // it is the one you can hold in your head; the baseline sits
          // under it as the answer to "but is that normal?"
          <div className="flex flex-col gap-1">
            {comparison ? <ComparisonIndicator comparison={comparison.income} previousLabel={previousMonthLabel} /> : null}
            {baseline ? <ComparisonIndicator comparison={baseline.income} previousLabel="12-mo avg" /> : null}
          </div>
        }
      />
      <StatCard
        label="Expenses"
        value={format(cents(summary.expenseCents))}
        comparison={
          // Stacked, not inline: two indicators side by side wrap
          // mid-phrase in a narrow stat card. Last month first, because
          // it is the one you can hold in your head; the baseline sits
          // under it as the answer to "but is that normal?"
          <div className="flex flex-col gap-1">
            {comparison ? <ComparisonIndicator comparison={comparison.expense} previousLabel={previousMonthLabel} /> : null}
            {baseline ? <ComparisonIndicator comparison={baseline.expense} previousLabel="12-mo avg" /> : null}
          </div>
        }
      />
      <StatCard
        label="Net"
        value={format(cents(summary.netCents), { signed: true })}
        comparison={
          // Stacked, not inline: two indicators side by side wrap
          // mid-phrase in a narrow stat card. Last month first, because
          // it is the one you can hold in your head; the baseline sits
          // under it as the answer to "but is that normal?"
          <div className="flex flex-col gap-1">
            {comparison ? <ComparisonIndicator comparison={comparison.net} previousLabel={previousMonthLabel} /> : null}
            {baseline ? <ComparisonIndicator comparison={baseline.net} previousLabel="12-mo avg" /> : null}
          </div>
        }
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
        hint="Daily average"
      />
      <StatCard label="Transactions" value={String(summary.transactionCount)} />
    </StatCardGrid>
  );
}

/**
 * The Year Overview's counterpart to `MonthNotReady` — shown when not one month
 * of the selected year has all its statements in.
 *
 * It reuses the same account list for the same reason: the answer to "why is
 * 2027 empty?" is "because December 2026 hasn't finished arriving", and the
 * dates say that directly.
 */
function YearNotReady({
  year,
  coverage,
}: {
  readonly year: number;
  readonly coverage: MonthCoverage;
}): React.ReactElement {
  return (
    <div role="status" className="bg-muted/40 rounded-md border p-6">
      <h2 className="text-sm font-semibold">No fully imported months in {year} yet</h2>
      <p className="text-muted-foreground mt-1 max-w-prose text-sm">
        Annual totals cover whole months only, so there is nothing to add up yet. They appear as soon
        as {year}&apos;s first month has data from every account.
      </p>

      {coverage.accounts.length > 0 ? (
        <dl className="mt-4 max-w-sm space-y-1 text-sm">
          {coverage.accounts.map((account) => (
            <div key={account.name} className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">{account.name}</dt>
              <dd className="text-muted-foreground">through {formatHumanDate(account.latestDate)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-muted-foreground mt-4 text-sm">Nothing imported yet.</p>
      )}

      <p className="text-muted-foreground mt-4 text-xs">
        The full year grid below still shows everything that has been imported.
      </p>
    </div>
  );
}

/**
 * What the owner sees instead of numbers, for a month whose statements have
 * not all landed.
 *
 * It names every account and the date its data currently reaches, because the
 * question this exists to answer is "why is my August empty?" — and "checking
 * through Aug 15, card through Aug 27" answers it completely, in one glance,
 * without the owner having to go and look. A bare "not enough data" would send
 * them hunting for a bug instead.
 *
 * Deliberately NOT styled as an error. This is the normal state of the current
 * month for most of every month: `role="status"`, muted, and it says plainly
 * what will make it go away.
 */
function MonthNotReady({
  coverage,
  year,
  month,
}: {
  readonly coverage: MonthCoverage;
  readonly year: number;
  readonly month: number;
}): React.ReactElement {
  const monthLabel = `${MONTH_ABBREVIATIONS[month - 1] ?? ''} ${year}`;

  return (
    <div role="status" className="bg-muted/40 rounded-md border p-6">
      <h2 className="text-sm font-semibold">{monthLabel} isn&apos;t fully imported yet</h2>
      <p className="text-muted-foreground mt-1 max-w-prose text-sm">
        Statements arrive mid-month, so these numbers would be counted against a period that
        hasn&apos;t finished. They appear once every account has data through{' '}
        {formatHumanDate(coverage.monthEnd)}.
      </p>

      {coverage.accounts.length > 0 ? (
        <dl className="mt-4 max-w-sm space-y-1 text-sm">
          {coverage.accounts.map((account) => (
            <div key={account.name} className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">{account.name}</dt>
              <dd className={account.latestDate >= coverage.monthEnd ? '' : 'text-muted-foreground'}>
                through {formatHumanDate(account.latestDate)}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-muted-foreground mt-4 text-sm">Nothing imported yet.</p>
      )}

      {coverage.dormant.length > 0 ? (
        <div className="mt-4 max-w-sm">
          {/* No "go and deactivate it" instruction: there is no Accounts screen
              to send anyone to, and the whole point of `partitionCoverage` is
              that this now resolves itself. This says what the app decided and
              why — nothing here is waiting on the owner. */}
          <p className="text-muted-foreground text-xs">
            {coverage.dormant.length === 1 ? 'Not waiting on this account' : 'Not waiting on these accounts'} — no
            statements in over two months, so {coverage.dormant.length === 1 ? 'it is' : 'they are'} treated as closed.
          </p>
          <dl className="text-muted-foreground mt-1 space-y-1 text-sm">
            {coverage.dormant.map((account) => (
              <div key={account.name} className="flex items-baseline justify-between gap-4">
                <dt>{account.name}</dt>
                <dd>through {formatHumanDate(account.latestDate)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      <p className="text-muted-foreground mt-4 text-xs">
        The full year grid below still shows everything that has been imported.
      </p>
    </div>
  );
}
