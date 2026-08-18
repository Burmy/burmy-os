import Link from 'next/link';

import { EmptyState } from '@/components/finance/empty-state';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { TopExpenseRow } from '@/server/db/finance/grid';
import { cents, format } from '@/server/finance/money';

/**
 * Rows link into the Transactions ledger (`/finance/transactions`) filtered
 * to this month and searched by merchant — the closest thing to "open this
 * transaction" that exists, since there is no single-transaction detail
 * view anywhere in the app (M9 deliberately deferred one). Approximate, not
 * exact: the search can match more than the one row if the same merchant
 * appears twice in a month.
 */
export function LargestExpensesList({
  expenses,
  year,
  month,
}: {
  readonly expenses: readonly TopExpenseRow[];
  readonly year: number;
  readonly month: number;
}): React.ReactElement {
  if (expenses.length === 0) {
    return <EmptyState>No expenses recorded this month.</EmptyState>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Merchant</TableHead>
          <TableHead>Category</TableHead>
          <TableHead className="text-right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {expenses.map((expense) => {
          const label = expense.normalizedMerchant ?? expense.originalDescription;
          const href = `/finance/transactions?year=${year}&month=${month}&q=${encodeURIComponent(label)}`;
          return (
            <TableRow key={expense.id}>
              <TableCell className="text-muted-foreground whitespace-nowrap">{expense.transactionDate}</TableCell>
              <TableCell>
                <Link href={href} className="hover:underline focus-visible:underline">
                  {label}
                </Link>
              </TableCell>
              <TableCell className="text-muted-foreground">{expense.categoryName ?? 'Uncategorized'}</TableCell>
              <TableCell className="tabular text-right whitespace-nowrap">{format(cents(expense.amountCents))}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
