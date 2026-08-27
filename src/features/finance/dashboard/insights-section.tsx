import type { TopExpenseRow } from '@/server/db/finance/grid';
import { MONTH_ABBREVIATIONS } from '@/server/finance/grid';
import type { BiggestSpendingDay, CategoryAmount, MonthSummary } from '@/server/finance/dashboard';
import { cents, format } from '@/server/finance/money';
import { formatPercent } from '@/components/finance/format-percent';
import { StatCard } from '@/components/ui/stat-card';
import { StatCardGrid } from '@/components/ui/stat-card-grid';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * INSIGHTS ARE `StatCard`s. THERE IS NO SEPARATE "SMALL CARD" ANY MORE.
 *
 * `InsightItem` used to be its own component with its own padding, its own type
 * scale and a `flex-wrap`/`basis-56` layout — so every insight sized itself to
 * whatever space was left, and a row of them came out visibly ragged, none of
 * them matching the stat cards directly above.
 *
 * Its props were `label`/`value`/`sub`, which is `StatCard`'s
 * `label`/`value`/`hint` renamed. Two components for one shape is how they
 * drifted apart in the first place, so the copy is gone and these are the real
 * thing, in the same `StatCardGrid` as every other card in the app.
 * ─────────────────────────────────────────────────────────────────────────────
 */


function monthLabel(summary: MonthSummary): string {
  return `${MONTH_ABBREVIATIONS[summary.month - 1]} ${summary.year}`;
}

/**
 * Every card is optional and only renders when the underlying data exists —
 * a brand-new owner with one month of history sees the three all-time
 * "highest month" cards too (that one month trivially IS the highest), but
 * an owner with zero spending this month sees no "largest expense" card
 * rather than a fabricated one.
 */
export function InsightsSection({
  largestExpense,
  topCategory,
  biggestSpendingDay,
  spendingDayYear,
  spendingDayMonth,
  averageTransactionCents,
  highestIncomeMonth,
  highestSpendingMonth,
  bestNetMonth,
}: {
  readonly largestExpense: TopExpenseRow | null;
  readonly topCategory: CategoryAmount | null;
  readonly biggestSpendingDay: BiggestSpendingDay | null;
  readonly spendingDayYear: number;
  readonly spendingDayMonth: number;
  readonly averageTransactionCents: number | null;
  readonly highestIncomeMonth: MonthSummary | null;
  readonly highestSpendingMonth: MonthSummary | null;
  readonly bestNetMonth: MonthSummary | null;
}): React.ReactElement | null {
  const items: React.ReactElement[] = [];

  if (largestExpense) {
    items.push(
      <StatCard
        key="largest-expense"
        label="Largest expense"
        value={format(cents(largestExpense.amountCents))}
        hint={largestExpense.normalizedMerchant ?? largestExpense.originalDescription}
      />,
    );
  }

  if (topCategory) {
    items.push(
      <StatCard
        key="top-category"
        label="Top spending category"
        value={topCategory.name}
        hint={`${format(cents(topCategory.amountCents))} · ${formatPercent(topCategory.percentOfExpenses)} of expenses`}
      />,
    );
  }

  if (biggestSpendingDay) {
    items.push(
      <StatCard
        key="biggest-day"
        label="Biggest spending day"
        value={`${MONTH_ABBREVIATIONS[spendingDayMonth - 1]} ${biggestSpendingDay.day}, ${spendingDayYear}`}
        hint={format(cents(biggestSpendingDay.amountCents))}
      />,
    );
  }

  if (averageTransactionCents !== null) {
    items.push(
      <StatCard key="avg-transaction" label="Average transaction" value={format(cents(Math.round(averageTransactionCents)))} />,
    );
  }

  if (highestIncomeMonth && highestIncomeMonth.incomeCents > 0) {
    items.push(
      <StatCard
        key="highest-income"
        label="Highest-income month"
        // Already sign-flipped to positive by `getMonthlyTotalsAllTime` — see the
        // same note on the Income stat card in `finance-dashboard.tsx`.
        value={format(cents(highestIncomeMonth.incomeCents), { signed: true })}
        hint={monthLabel(highestIncomeMonth)}
      />,
    );
  }

  if (highestSpendingMonth && highestSpendingMonth.expenseCents > 0) {
    items.push(
      <StatCard
        key="highest-spending"
        label="Highest-spending month"
        value={format(cents(highestSpendingMonth.expenseCents))}
        hint={monthLabel(highestSpendingMonth)}
      />,
    );
  }

  if (bestNetMonth) {
    items.push(
      <StatCard
        key="best-net"
        label="Best net month"
        value={format(cents(bestNetMonth.netCents), { signed: true })}
        hint={monthLabel(bestNetMonth)}
      />,
    );
  }

  if (items.length === 0) return null;

  return (
    <div>
      {/* Same heading treatment as `Section` — `text-base font-medium` over a
          12px gap. These were `text-sm` over 8px, which is a third heading
          style for the same job and part of why this block read as foreign. */}
      <h2 className="font-display text-base font-medium">Insights</h2>
      <div className="mt-3">
        <StatCardGrid>{items}</StatCardGrid>
      </div>
    </div>
  );
}
