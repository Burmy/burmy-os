import type { TopExpenseRow } from '@/server/db/finance/grid';
import { MONTH_ABBREVIATIONS } from '@/server/finance/grid';
import type { BiggestSpendingDay, CategoryAmount, MonthSummary } from '@/server/finance/dashboard';
import { cents, format } from '@/server/finance/money';
import { formatPercent } from '@/components/finance/format-percent';

function InsightItem({
  label,
  value,
  sub,
}: {
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
}): React.ReactElement {
  return (
    <div className="min-w-40 max-w-64 flex-1 basis-40 rounded-lg border bg-card p-3">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="tabular mt-0.5 truncate text-sm font-semibold" title={value}>
        {value}
      </div>
      {sub ? <div className="text-muted-foreground mt-0.5 truncate text-xs">{sub}</div> : null}
    </div>
  );
}

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
      <InsightItem
        key="largest-expense"
        label="Largest expense"
        value={format(cents(largestExpense.amountCents))}
        sub={largestExpense.normalizedMerchant ?? largestExpense.originalDescription}
      />,
    );
  }

  if (topCategory) {
    items.push(
      <InsightItem
        key="top-category"
        label="Top spending category"
        value={topCategory.name}
        sub={`${format(cents(topCategory.amountCents))} · ${formatPercent(topCategory.percentOfExpenses)} of expenses`}
      />,
    );
  }

  if (biggestSpendingDay) {
    items.push(
      <InsightItem
        key="biggest-day"
        label="Biggest spending day"
        value={`${MONTH_ABBREVIATIONS[spendingDayMonth - 1]} ${biggestSpendingDay.day}, ${spendingDayYear}`}
        sub={format(cents(biggestSpendingDay.amountCents))}
      />,
    );
  }

  if (averageTransactionCents !== null) {
    items.push(
      <InsightItem key="avg-transaction" label="Average transaction" value={format(cents(Math.round(averageTransactionCents)))} />,
    );
  }

  if (highestIncomeMonth && highestIncomeMonth.incomeCents > 0) {
    items.push(
      <InsightItem
        key="highest-income"
        label="Highest-income month"
        // Already sign-flipped to positive by `getMonthlyTotalsAllTime` — see the
        // same note on the Income stat card in `finance-dashboard.tsx`.
        value={format(cents(highestIncomeMonth.incomeCents), { signed: true })}
        sub={monthLabel(highestIncomeMonth)}
      />,
    );
  }

  if (highestSpendingMonth && highestSpendingMonth.expenseCents > 0) {
    items.push(
      <InsightItem
        key="highest-spending"
        label="Highest-spending month"
        value={format(cents(highestSpendingMonth.expenseCents))}
        sub={monthLabel(highestSpendingMonth)}
      />,
    );
  }

  if (bestNetMonth) {
    items.push(
      <InsightItem
        key="best-net"
        label="Best net month"
        value={format(cents(bestNetMonth.netCents), { signed: true })}
        sub={monthLabel(bestNetMonth)}
      />,
    );
  }

  if (items.length === 0) return null;

  return (
    <div>
      <h2 className="text-sm font-medium">Insights</h2>
      {/* flex-wrap, not a fixed grid — with only 1-2 insights available (a
          brand-new owner), a 4-column grid leaves large empty cells that read
          as unfinished. Flexible, bounded-width cards just sit compactly
          instead, and still wrap into a full grid-like row once there are
          enough of them. */}
      <div className="mt-2 flex flex-wrap gap-2">{items}</div>
    </div>
  );
}
