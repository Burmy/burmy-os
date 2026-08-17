'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { TRANSACTION_TYPE_LABELS } from '@/server/finance/classify/manual';
import { MONTH_ABBREVIATIONS, type GridColumn, type GridRowTotals, type MonthlyGrid } from '@/server/finance/grid';
import { cents, format } from '@/server/finance/money';
import { getCellDrillDownAction, type DrillDownResult } from './actions';

type Selector = { readonly kind: 'category'; readonly categoryId: string } | { readonly kind: 'expenditure' } | { readonly kind: 'income' };

type DialogState =
  | { readonly mode: 'transactions'; readonly title: string; readonly month: number | null; readonly selector: Selector; readonly flipSign: boolean }
  | { readonly mode: 'breakdown'; readonly title: string; readonly month: number | null; readonly totals: GridRowTotals };

function money(valueCents: number): string {
  return format(cents(valueCents), { signed: true });
}

function displayCents(cell: { readonly amountCents: number }, column: GridColumn): number {
  return column.kind === 'income' ? -cell.amountCents : cell.amountCents;
}

function monthLabel(month: number | null): string {
  return month === null ? '' : (MONTH_ABBREVIATIONS[month - 1] ?? '');
}

/**
 * The M8 grid: months × the owner's categories, in `sort_order` — never
 * regrouped by `kind`, per CLAUDE.md. Every cell with a transaction is a
 * button; every button opens the SAME dialog, fetching through the SAME
 * Server Action that reads through the SAME base filter the aggregate query
 * used to produce the number being clicked.
 */
export function MonthlyGridTable({
  grid,
  year,
  years,
}: {
  readonly grid: MonthlyGrid;
  readonly year: number;
  readonly years: readonly number[];
}): React.ReactElement {
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [result, setResult] = useState<DrillDownResult | null>(null);
  const [pending, startTransition] = useTransition();

  function changeYear(value: string): void {
    router.push(`/finance/monthly?year=${value}`);
  }

  function openTransactions(title: string, month: number | null, selector: Selector, flipSign: boolean): void {
    setDialog({ mode: 'transactions', title, month, selector, flipSign });
    setResult(null);
    startTransition(async () => {
      const data = await getCellDrillDownAction(year, month, selector);
      setResult(data);
    });
  }

  function openBreakdown(title: string, month: number | null, totals: GridRowTotals): void {
    setDialog({ mode: 'breakdown', title, month, totals });
  }

  function closeDialog(): void {
    setDialog(null);
    setResult(null);
  }

  const yearsWithCurrent = years.includes(year) ? years : [year, ...years];

  return (
    <div className="mt-6 space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-sm">Year</span>
        <Select value={String(year)} onValueChange={changeYear}>
          <SelectTrigger aria-label="Year" className="h-8 w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {yearsWithCurrent.map((y) => (
              <SelectItem key={y} value={String(y)}>
                {y}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Month</TableHead>
            {grid.columns.map((column) => (
              <TableHead key={column.id} className="text-right whitespace-nowrap">
                <div>
                  {column.name}
                  {column.archived ? ' (archived)' : ''}
                </div>
                <div className="text-muted-foreground text-[10px] font-normal uppercase">{column.kind}</div>
              </TableHead>
            ))}
            <TableHead className="text-right whitespace-nowrap">Total Expenditure</TableHead>
            <TableHead className="text-right whitespace-nowrap">Income</TableHead>
            <TableHead className="text-right whitespace-nowrap">Gross Savings</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {grid.rows.map((row) => (
            <TableRow key={row.month}>
              <TableCell className="text-muted-foreground whitespace-nowrap">{monthLabel(row.month)}</TableCell>
              {grid.columns.map((column) => {
                const cell = row.cells[column.id];
                return (
                  <TableCell key={column.id} className="tabular text-right whitespace-nowrap">
                    {cell ? (
                      <button
                        type="button"
                        className="hover:underline"
                        onClick={() =>
                          openTransactions(
                            `${column.name} — ${monthLabel(row.month)} ${year}`,
                            row.month,
                            { kind: 'category', categoryId: column.id },
                            column.kind === 'income',
                          )
                        }
                      >
                        {money(displayCents(cell, column))}
                      </button>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                );
              })}
              <TableCell className="tabular text-right whitespace-nowrap">
                <button
                  type="button"
                  className="hover:underline"
                  onClick={() =>
                    openTransactions(
                      `Total Expenditure — ${monthLabel(row.month)} ${year}`,
                      row.month,
                      { kind: 'expenditure' },
                      false,
                    )
                  }
                >
                  {money(row.totalExpenditureCents)}
                </button>
              </TableCell>
              <TableCell className="tabular text-right whitespace-nowrap">
                <button
                  type="button"
                  className="hover:underline"
                  onClick={() =>
                    openTransactions(`Income — ${monthLabel(row.month)} ${year}`, row.month, { kind: 'income' }, true)
                  }
                >
                  {money(row.incomeCents)}
                </button>
              </TableCell>
              <TableCell className="tabular text-right whitespace-nowrap">
                <button
                  type="button"
                  className="hover:underline"
                  onClick={() => openBreakdown(`Gross Savings — ${monthLabel(row.month)} ${year}`, row.month, row)}
                >
                  {money(row.grossSavingsCents)}
                </button>
              </TableCell>
            </TableRow>
          ))}

          <TableRow className="font-medium">
            <TableCell>Total</TableCell>
            {grid.columns.map((column) => {
              const cell = grid.yearTotal.cells[column.id];
              return (
                <TableCell key={column.id} className="tabular text-right whitespace-nowrap">
                  {cell ? (
                    <button
                      type="button"
                      className="hover:underline"
                      onClick={() =>
                        openTransactions(
                          `${column.name} — ${year}`,
                          null,
                          { kind: 'category', categoryId: column.id },
                          column.kind === 'income',
                        )
                      }
                    >
                      {money(displayCents(cell, column))}
                    </button>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              );
            })}
            <TableCell className="tabular text-right whitespace-nowrap">
              <button
                type="button"
                className="hover:underline"
                onClick={() => openTransactions(`Total Expenditure — ${year}`, null, { kind: 'expenditure' }, false)}
              >
                {money(grid.yearTotal.totalExpenditureCents)}
              </button>
            </TableCell>
            <TableCell className="tabular text-right whitespace-nowrap">
              <button
                type="button"
                className="hover:underline"
                onClick={() => openTransactions(`Income — ${year}`, null, { kind: 'income' }, true)}
              >
                {money(grid.yearTotal.incomeCents)}
              </button>
            </TableCell>
            <TableCell className="tabular text-right whitespace-nowrap">
              <button
                type="button"
                className="hover:underline"
                onClick={() => openBreakdown(`Gross Savings — ${year}`, null, grid.yearTotal)}
              >
                {money(grid.yearTotal.grossSavingsCents)}
              </button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>

      <Dialog open={dialog !== null} onOpenChange={(open) => (open ? null : closeDialog())}>
        <DialogContent className="max-w-2xl">
          {dialog?.mode === 'transactions' ? (
            <>
              <DialogHeader>
                <DialogTitle>{dialog.title}</DialogTitle>
                <DialogDescription>
                  {result ? `${result.transactions.length} transaction${result.transactions.length === 1 ? '' : 's'}` : 'Loading…'}
                </DialogDescription>
              </DialogHeader>

              {pending || !result ? (
                <p className="text-muted-foreground py-8 text-center text-sm">Loading…</p>
              ) : result.transactions.length === 0 ? (
                <p className="text-muted-foreground py-8 text-center text-sm">No transactions.</p>
              ) : (
                <div className="max-h-[60vh] overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Account</TableHead>
                        <TableHead>Merchant</TableHead>
                        <TableHead>Category</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.transactions.map((transaction) => (
                        <TableRow key={transaction.id}>
                          <TableCell className="text-muted-foreground whitespace-nowrap">
                            {transaction.transactionDate}
                          </TableCell>
                          <TableCell className="text-muted-foreground">{transaction.accountName}</TableCell>
                          <TableCell>
                            <div className="font-medium">{transaction.normalizedMerchant}</div>
                            <div className="text-muted-foreground text-xs">{transaction.originalDescription}</div>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {transaction.categoryName ?? 'Uncategorized'}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {TRANSACTION_TYPE_LABELS[transaction.transactionType] ?? transaction.transactionType}
                          </TableCell>
                          <TableCell className="tabular text-right whitespace-nowrap">
                            {money(dialog.flipSign ? -transaction.amountCents : transaction.amountCents)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {result ? (
                <DialogFooter className="justify-between sm:justify-between">
                  <span className="text-muted-foreground text-sm">
                    This matches the grid cell you clicked — same filter, same rows.
                  </span>
                  <span className="tabular font-medium">
                    Total: {money(dialog.flipSign ? -result.totalCents : result.totalCents)}
                  </span>
                </DialogFooter>
              ) : null}
            </>
          ) : null}

          {dialog?.mode === 'breakdown' ? (
            <>
              <DialogHeader>
                <DialogTitle>{dialog.title}</DialogTitle>
                <DialogDescription>
                  Gross Savings is Income minus Total Expenditure — not one transaction list. Its two components
                  each drill down on their own.
                </DialogDescription>
              </DialogHeader>

              <dl className="space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <dt>Income</dt>
                  <dd>
                    <Button
                      variant="link"
                      className="h-auto p-0 tabular"
                      onClick={() =>
                        openTransactions(
                          `Income — ${dialog.title.split(' — ')[1] ?? year}`,
                          dialog.month,
                          { kind: 'income' },
                          true,
                        )
                      }
                    >
                      {money(dialog.totals.incomeCents)}
                    </Button>
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt>Total Expenditure</dt>
                  <dd>
                    <Button
                      variant="link"
                      className="h-auto p-0 tabular"
                      onClick={() =>
                        openTransactions(
                          `Total Expenditure — ${dialog.title.split(' — ')[1] ?? year}`,
                          dialog.month,
                          { kind: 'expenditure' },
                          false,
                        )
                      }
                    >
                      {money(dialog.totals.totalExpenditureCents)}
                    </Button>
                  </dd>
                </div>
                <div className="flex items-center justify-between border-t pt-3 font-medium">
                  <dt>Gross Savings</dt>
                  <dd className="tabular">{money(dialog.totals.grossSavingsCents)}</dd>
                </div>
              </dl>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
