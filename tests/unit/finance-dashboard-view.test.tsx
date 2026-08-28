import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { FinanceDashboard, type FinanceDashboardProps } from '@/features/finance/dashboard/finance-dashboard';

/**
 * WHY THIS FILE EXISTS.
 *
 * The statement-coverage work shipped with 1,267 passing unit tests, a clean
 * typecheck and a clean lint, and was still broken on the owner's real data in
 * two visible ways:
 *
 *   1. A retired account held the coverage line eight months in the past, so
 *      every month rendered `MonthNotReady` instead of stat cards.
 *   2. With no covered month in the selected year, the Year Overview printed a
 *      row of $0.00 cards and two empty charts — directly above a Full year grid
 *      showing real numbers.
 *
 * Both were pure-function results being rendered; neither pure function was
 * wrong on its own inputs, and there was no test that RENDERED this component at
 * all. `finance-dashboard.test.ts` tests the arithmetic, which is the part that
 * was already correct.
 *
 * So these are deliberately not more arithmetic tests. Each one asserts what is
 * on the screen in a state the owner actually hit, and the two marked
 * "REGRESSION" fail against the code as shipped.
 *
 * `useRouter` is mocked for `MonthNavigator`'s `useNavigate`, the same way every
 * other component test in this suite does it.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

// Recharts measures its container, which jsdom reports as 0x0 — charts render
// nothing and their surrounding Sections still mount. Nothing here asserts on
// chart internals; the assertions are about which BLOCKS are on screen.

const summary = { year: 2026, month: 7, incomeCents: 640_000, expenseCents: 512_345, netCents: 127_655, transactionCount: 96 };

function props(overrides: Partial<FinanceDashboardProps> = {}): FinanceDashboardProps {
  return {
    year: 2026,
    month: 7,
    years: [2026, 2025],
    coverage: {
      covered: true,
      monthEnd: '2026-07-31',
      accounts: [
        { name: 'BoA Checking', latestDate: '2026-08-07' },
        { name: 'BoA Credit Card', latestDate: '2026-08-26' },
      ],
      dormant: [],
    },
    previousMonthLabel: 'Jun',
    actions: null,
    summary,
    comparison: null,
    baseline: null,
    savingsRatePercent: 19.9,
    avgDailySpendingCents: 16_527,
    avgTransactionCents: 5_337,
    trend: [],
    categoryBreakdown: [],
    categoryTrend: [],
    topExpenses: [],
    insights: {
      largestExpense: null,
      topCategory: null,
      biggestSpendingDay: null,
      highestIncomeMonth: null,
      highestSpendingMonth: null,
      bestNetMonth: null,
    },
    ytd: {
      summary: {
        year: 2026,
        monthsElapsed: 7,
        incomeCents: 4_480_000,
        expenseCents: 3_586_415,
        netCents: 893_585,
        averageMonthlyExpenseCents: 512_345,
        savingsRatePercent: 19.9,
        highestSpendingMonth: null,
      },
      trend: [],
      annualCategories: [],
      yearlyBreakdown: { months: [], series: [] },
    },
    ...overrides,
  };
}

/** The This Year tab is behind a toggle, and every year-view assertion needs it. */
async function openYearView(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: 'This Year' }));
}

describe('FinanceDashboard — month view', () => {
  it('shows the headline numbers for a covered month', () => {
    render(<FinanceDashboard {...props()} />);

    expect(screen.getByText('$6,400.00')).toBeInTheDocument();
    expect(screen.getByText('$5,123.45')).toBeInTheDocument();
    expect(screen.queryByText(/isn.t fully imported yet/i)).not.toBeInTheDocument();
  });

  it('renders income as a POSITIVE figure', () => {
    // `summary.incomeCents` is already sign-flipped at the DB boundary. The
    // Income card once ran it through `formatInflow` as well and printed
    // -$6,400.00 for a real paycheck — a bug that reached the running app
    // because nothing rendered this card.
    render(<FinanceDashboard {...props()} />);

    expect(screen.getByText('$6,400.00')).toBeInTheDocument();
    expect(screen.queryByText('-$6,400.00')).not.toBeInTheDocument();
  });

  it('replaces every number with an explanation when the month is not covered', () => {
    render(
      <FinanceDashboard
        {...props({
          coverage: {
            covered: false,
            monthEnd: '2026-08-31',
            accounts: [
              { name: 'BoA Checking', latestDate: '2026-08-07' },
              { name: 'BoA Credit Card', latestDate: '2026-08-26' },
            ],
            dormant: [],
          },
        })}
      />,
    );

    expect(screen.getByText(/isn.t fully imported yet/i)).toBeInTheDocument();
    // Each account and the date its data reaches — the whole answer to "why is
    // this empty?", on screen rather than inferable.
    expect(screen.getByText('BoA Checking')).toBeInTheDocument();
    expect(screen.getByText('through Aug 7, 2026')).toBeInTheDocument();
    expect(screen.getByText('through Aug 26, 2026')).toBeInTheDocument();
    // The stat cards are gone, not merely zeroed.
    expect(screen.queryByText('$5,123.45')).not.toBeInTheDocument();
  });

  it('names a written-off account and says it is not being waited on', () => {
    // REGRESSION — the retired "Historical (2024-2025)" account. It must appear
    // (an account silently dropped from the rule is unexplainable) and it must
    // be clearly separated from the accounts actually holding the month up.
    render(
      <FinanceDashboard
        {...props({
          coverage: {
            covered: false,
            monthEnd: '2026-08-31',
            accounts: [{ name: 'BoA Checking', latestDate: '2026-08-07' }],
            dormant: [{ name: 'Historical (2024-2025)', latestDate: '2025-12-01' }],
          },
        })}
      />,
    );

    expect(screen.getByText('Historical (2024-2025)')).toBeInTheDocument();
    expect(screen.getByText(/not waiting on this account/i)).toBeInTheDocument();
    expect(screen.getByText('through Dec 1, 2025')).toBeInTheDocument();
  });

  it('keeps the trend charts up even for an uncovered month', () => {
    // They are history, already trimmed at the last covered month, so gating
    // them too would leave the page with nothing at all on it.
    render(
      <FinanceDashboard
        {...props({
          coverage: { covered: false, monthEnd: '2026-08-31', accounts: [], dormant: [] },
        })}
      />,
    );

    expect(screen.getByText('Income vs Expenses')).toBeInTheDocument();
    expect(screen.getByText('Net cash flow')).toBeInTheDocument();
  });
});

describe('FinanceDashboard — year view', () => {
  it('shows YTD figures when the year has covered months', async () => {
    render(<FinanceDashboard {...props()} />);
    await openYearView();

    expect(screen.getByText('YTD Income')).toBeInTheDocument();
    expect(screen.getByText('$44,800.00')).toBeInTheDocument();
    expect(screen.queryByText(/no fully imported months/i)).not.toBeInTheDocument();
  });

  it('labels a completed year without the "YTD" prefix', async () => {
    render(
      <FinanceDashboard
        {...props({
          ytd: { ...props().ytd, summary: { ...props().ytd.summary, monthsElapsed: 12 } },
        })}
      />,
    );
    await openYearView();

    expect(screen.getByText('Income')).toBeInTheDocument();
    expect(screen.queryByText('YTD Income')).not.toBeInTheDocument();
  });

  it('says nothing is covered instead of printing $0.00 across the board', async () => {
    // REGRESSION — the zeroed Year Overview. `monthsElapsed: 0` is an honest
    // result (no month of this year is covered), but rendering it as a row of
    // real-looking $0.00 cards above a grid full of real numbers is not an
    // honest way to show it.
    render(
      <FinanceDashboard
        {...props({
          ytd: {
            ...props().ytd,
            summary: {
              year: 2026,
              monthsElapsed: 0,
              incomeCents: 0,
              expenseCents: 0,
              netCents: 0,
              averageMonthlyExpenseCents: 0,
              savingsRatePercent: null,
              highestSpendingMonth: null,
            },
          },
        })}
      />,
    );
    await openYearView();

    expect(screen.getByText('No fully imported months in 2026 yet')).toBeInTheDocument();
    expect(screen.queryByText('YTD Income')).not.toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
    // The account dates explain WHY, here as much as in the month view.
    expect(screen.getByText('BoA Checking')).toBeInTheDocument();
  });
});
