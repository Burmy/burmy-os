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
import { daysInMonth } from '@/server/finance/dashboard';
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
  /** Days of the month with any spending, out of the month's days (2026-10-19). */
  readonly spendingDays: { readonly days: number; readonly of: number };
  /** Outflow transactions only — beside the all-transactions count (2026-10-19). */
  readonly expenseTransactionCount: number;
  readonly trend: readonly TrendPoint[];
  readonly categoryBreakdown: readonly CategoryAmount[];
  readonly categoryTrend: readonly CategoryTrendSeries[];
  readonly topExpenses: readonly TopExpenseRow[];
  readonly insights: {
    readonly largestExpense: TopExpenseRow | null;
    readonly largestIncome: TopExpenseRow | null;
    readonly topCategory: CategoryAmount | null;
    readonly biggestSpendingDay: BiggestSpendingDay | null;
    readonly highestIncomeMonth: MonthSummary | null;
    readonly highestSpendingMonth: MonthSummary | null;
    readonly bestNetMonth: MonthSummary | null;
  };
  readonly ytd: {
    readonly summary: YtdSummary;
    /** Outflow transactions across the months counted, for the year view's own card (2026-10-19). */
    readonly expenseTransactionCount: number;
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
  spendingDays,
  expenseTransactionCount,
  trend,
  categoryBreakdown,
  categoryTrend,
  topExpenses,
  insights,
  ytd,
}: FinanceDashboardProps): React.ReactElement {
  const [view, setView] = useState<'month' | 'year'>('month');
  const isCompletedYear = ytd.summary.monthsElapsed >= 12;
  // Whole months only, like the month card's whole-month divisor.
  const ytdDaysCounted = Array.from({ length: ytd.summary.monthsElapsed }, (_, index) =>
    daysInMonth(ytd.summary.year, index + 1),
  ).reduce((sum, days) => sum + days, 0);

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
          {/* THE MONTH'S NUMBERS ALWAYS SHOW. Until 2026-10-19 a month whose
              statements had not all arrived rendered an explanation INSTEAD of
              its cards — a savings rate from two weeks of card spending against
              a full month of income is a wrong number, and the gate kept it off
              the screen. The owner wanted the figures anyway ("I should be able
              to see previous months' expenses regardless"), so the gate became
              a note: one quiet line saying how far each account's data reaches,
              above numbers that cover exactly what has arrived. The reader
              decides what a partial month means; the page no longer does. */}
          {coverage.covered ? null : <CoverageNote coverage={coverage} year={year} month={month} />}
          <MonthStats
            summary={summary}
            comparison={comparison}
            baseline={baseline}
            previousMonthLabel={previousMonthLabel}
            savingsRatePercent={savingsRatePercent}
            avgDailySpendingCents={avgDailySpendingCents}
            spendingDays={spendingDays}
            expenseTransactionCount={expenseTransactionCount}
          />

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <Section title="Income vs Expenses" description="Most recent months of activity">
              <IncomeExpenseTrendChart points={trend} />
            </Section>
            <Section title="Net cash flow" description="Income minus expenses, per month">
              <NetCashflowChart points={trend} />
            </Section>
          </div>

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
              largestIncome={insights.largestIncome}
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
        </div>
      ) : ytd.summary.monthsElapsed === 0 ? (
        // NOT A ROW OF $0.00 CARDS. Nothing is imported for this year at all,
        // so every annual figure would be a sum over nothing. Say so instead of
        // printing zeros. (Since 2026-10-19 a year with ANY data shows its
        // figures, partial months included — see the month view above.)
        <YearNotReady year={ytd.summary.year} coverage={coverage} />
      ) : (
        <div className={SECTION_STACK}>
          <StatCardGrid>
            <StatCard
              label={isCompletedYear ? 'Income' : 'YTD Income'}
              value={format(cents(ytd.summary.incomeCents), { signed: true })}
            />
            <StatCard
              label={isCompletedYear ? 'Expenses' : 'YTD Expenses'}
              value={format(cents(ytd.summary.expenseCents))}
            />
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
              value={
                ytd.summary.savingsRatePercent === null
                  ? '—'
                  : formatPercent(ytd.summary.savingsRatePercent)
              }
              {...(ytd.summary.savingsRatePercent === null ? { hint: 'No income yet' } : {})}
            />
            {/* Three more so the four-wide grid fills both rows (owner,
                2026-10-19: "I don't like random white spaces"). */}
            <StatCard
              label="Avg. daily spending"
              value={
                ytdDaysCounted === 0
                  ? '—'
                  : format(cents(Math.round(ytd.summary.expenseCents / ytdDaysCounted)))
              }
              hint={`over ${ytdDaysCounted} days`}
            />
            <StatCard
              label="Expense transactions"
              value={ytd.expenseTransactionCount.toLocaleString('en-US')}
              hint={`across ${ytd.summary.monthsElapsed} month${ytd.summary.monthsElapsed === 1 ? '' : 's'}`}
            />
            <StatCard
              label="Months imported"
              value={`${ytd.summary.monthsElapsed} of 12`}
              hint={isCompletedYear ? 'Complete year' : 'Through the newest statement'}
            />
          </StatCardGrid>

          <Section
            title={`${ytd.summary.year} income vs expenses`}
            description={isCompletedYear ? 'Every month this year' : 'Every month so far this year'}
          >
            <IncomeExpenseTrendChart points={ytd.trend} />
          </Section>

          <Section
            title="Yearly breakdown"
            description="Why one month cost more than another — Jan through Dec"
          >
            <YearlyBreakdownChart breakdown={ytd.yearlyBreakdown} />
          </Section>

          <Section title="Spending by category" description={`${ytd.summary.year}, largest first`}>
            <AnnualCategoryChart
              categories={ytd.annualCategories}
              totalCents={ytd.summary.expenseCents}
            />
          </Section>
        </div>
      )}
    </div>
  );
}

/**
 * The eight headline cards — two rows of four, so the grid never ends on a
 * half-empty row (owner, 2026-10-19). Extracted from the body so the month
 * view reads as one block.
 */
function MonthStats({
  summary,
  comparison,
  baseline,
  previousMonthLabel,
  savingsRatePercent,
  avgDailySpendingCents,
  spendingDays,
  expenseTransactionCount,
}: {
  readonly summary: MonthSummary;
  readonly comparison: MonthComparison | null;
  readonly baseline: MonthComparison | null;
  readonly previousMonthLabel: string;
  readonly savingsRatePercent: number | null;
  readonly avgDailySpendingCents: number;
  readonly spendingDays: { readonly days: number; readonly of: number };
  readonly expenseTransactionCount: number;
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
            {comparison ? (
              <ComparisonIndicator
                comparison={comparison.income}
                previousLabel={previousMonthLabel}
              />
            ) : null}
            {baseline ? (
              <ComparisonIndicator comparison={baseline.income} previousLabel="12-mo avg" />
            ) : null}
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
            {comparison ? (
              <ComparisonIndicator
                comparison={comparison.expense}
                previousLabel={previousMonthLabel}
              />
            ) : null}
            {baseline ? (
              <ComparisonIndicator comparison={baseline.expense} previousLabel="12-mo avg" />
            ) : null}
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
            {comparison ? (
              <ComparisonIndicator comparison={comparison.net} previousLabel={previousMonthLabel} />
            ) : null}
            {baseline ? (
              <ComparisonIndicator comparison={baseline.net} previousLabel="12-mo avg" />
            ) : null}
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
      <StatCard
        label="Expense transactions"
        value={String(expenseTransactionCount)}
        hint={`of ${summary.transactionCount} in total`}
      />
      <StatCard
        label="Days with spending"
        value={`${spendingDays.days} of ${spendingDays.of}`}
        hint={spendingDays.days === 0 ? 'No spending recorded' : 'Days with at least one expense'}
      />
    </StatCardGrid>
  );
}

/**
 * The Year Overview with nothing to add up — shown when not one month of the
 * selected year has any data. The account list answers "why is 2027 empty?":
 * because nothing has reached 2027 yet, and the dates say so directly.
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
      <h2 className="text-sm font-semibold">Nothing imported for {year} yet</h2>
      <p className="text-muted-foreground mt-1 max-w-prose text-sm">
        There is nothing to add up. The annual figures appear as soon as a {year} statement is
        imported.
      </p>

      {coverage.accounts.length > 0 ? (
        <dl className="mt-4 max-w-sm space-y-1 text-sm">
          {coverage.accounts.map((account) => (
            <div key={account.name} className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">{account.name}</dt>
              <dd className="text-muted-foreground">
                through {formatHumanDate(account.latestDate)}
              </dd>
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
 * One quiet line above a month whose statements have not all landed yet.
 *
 * It names every account still short of the month's end and the date its data
 * reaches, because "why does September look light?" is answered completely by
 * "card through Sep 25" — on screen, without going to look. Accounts
 * `partitionCoverage` has written off are not listed: nothing is waiting on
 * them, and the note is for what IS still to come.
 *
 * Deliberately NOT styled as an error and deliberately not a panel: this is
 * the normal state of the current month for most of every month, and until
 * 2026-10-19 it was a full card that replaced the numbers (`MonthNotReady`).
 * The owner wanted the numbers; the explanation shrank to fit above them.
 */
function CoverageNote({
  coverage,
  year,
  month,
}: {
  readonly coverage: MonthCoverage;
  readonly year: number;
  readonly month: number;
}): React.ReactElement {
  const monthLabel = `${MONTH_ABBREVIATIONS[month - 1] ?? ''} ${year}`;
  const waiting = coverage.accounts.filter((account) => account.latestDate < coverage.monthEnd);

  return (
    <p role="status" className="text-muted-foreground text-xs">
      <span className="text-foreground font-medium">
        {monthLabel} isn&apos;t fully imported yet
      </span>
      {' — figures cover what has arrived. '}
      {waiting.length === 0
        ? 'Nothing imported yet.'
        : waiting
            .map((account) => `${account.name} through ${formatHumanDate(account.latestDate)}`)
            .join(' · ')}
    </p>
  );
}
