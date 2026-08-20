'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { InlineEditText } from '@/components/finance/inline-edit-text';
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
import { toast } from '@/components/ui/toast';
import { formatHumanDate } from '@/lib/format-date';
import { cn } from '@/lib/utils';
import type { FinanceCategory } from '@/server/db/finance/categories';
import type { DrillDownTransaction } from '@/server/db/finance/grid';
import { MANUAL_TRANSACTION_TYPES, TRANSACTION_TYPE_LABELS, type ManualTransactionType } from '@/server/finance/classify/manual';
import { MONTH_ABBREVIATIONS, type GridColumn, type GridRowTotals, type MonthlyGrid } from '@/server/finance/grid';
import { cents, format } from '@/server/finance/money';
import {
  updateTransactionCategoryAction,
  updateTransactionMerchantAction,
  updateTransactionNoteAction,
  updateTransactionTypeAction,
} from '../transactions/actions';
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
  categories,
}: {
  readonly grid: MonthlyGrid;
  readonly year: number;
  readonly years: readonly number[];
  readonly categories: readonly FinanceCategory[];
}): React.ReactElement {
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [result, setResult] = useState<DrillDownResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [, startEditTransition] = useTransition();

  function patchTransaction(id: string, patch: Partial<DrillDownTransaction>): void {
    setResult((prev) =>
      prev ? { ...prev, transactions: prev.transactions.map((t) => (t.id === id ? { ...t, ...patch } : t)) } : prev,
    );
  }

  function changeCategory(row: DrillDownTransaction, categoryId: string | null): void {
    const previous = { categoryId: row.categoryId, categoryName: row.categoryName };
    const category = categories.find((c) => c.id === categoryId);
    patchTransaction(row.id, { categoryId, categoryName: category?.name ?? null });

    startEditTransition(async () => {
      const outcome = await updateTransactionCategoryAction(row.id, categoryId, false);
      if (!outcome.ok) {
        toast.error(outcome.error);
        patchTransaction(row.id, previous);
        return;
      }
      router.refresh();
    });
  }

  function changeType(row: DrillDownTransaction, transactionType: ManualTransactionType): void {
    const previous = row.transactionType;
    patchTransaction(row.id, { transactionType });

    startEditTransition(async () => {
      const outcome = await updateTransactionTypeAction(row.id, transactionType);
      if (!outcome.ok) {
        toast.error(outcome.error);
        patchTransaction(row.id, { transactionType: previous });
        return;
      }
      router.refresh();
    });
  }

  function saveMerchant(row: DrillDownTransaction, value: string): void {
    const trimmed = value.trim();
    if (trimmed === (row.normalizedMerchant ?? '')) return;
    patchTransaction(row.id, { normalizedMerchant: trimmed === '' ? null : trimmed });

    startEditTransition(async () => {
      const outcome = await updateTransactionMerchantAction(row.id, trimmed);
      if (!outcome.ok) toast.error(outcome.error);
    });
  }

  function saveNote(row: DrillDownTransaction, value: string): void {
    const trimmed = value.trim();
    if (trimmed === (row.notes ?? '')) return;
    patchTransaction(row.id, { notes: trimmed === '' ? null : trimmed });

    startEditTransition(async () => {
      const outcome = await updateTransactionNoteAction(row.id, trimmed);
      if (!outcome.ok) toast.error(outcome.error);
    });
  }

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

  const clickableCell = 'text-foreground underline-offset-2 hover:underline focus-visible:underline';
  const stickyMonthCell = 'bg-background group-hover:bg-muted/40 sticky left-0 z-10';
  const negativeCell = (valueCents: number): string | undefined => (valueCents < 0 ? 'text-destructive' : undefined);

  return (
    <div className="mt-3 space-y-3">
      <div className="flex items-center gap-2">
        <Select value={String(year)} onValueChange={changeYear}>
          <SelectTrigger aria-label="Year" className="h-8 w-24 font-medium">
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
            <TableHead className={stickyMonthCell}>Month</TableHead>
            {grid.columns.map((column) => (
              <TableHead key={column.id} className="text-right whitespace-nowrap">
                {column.name}
                {column.archived ? ' (archived)' : ''}
              </TableHead>
            ))}
            <TableHead className="text-right whitespace-nowrap">Total Expenditure</TableHead>
            <TableHead className="text-right whitespace-nowrap">Income</TableHead>
            <TableHead className="text-right whitespace-nowrap">Gross Savings</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {grid.rows.map((row) => (
            <TableRow key={row.month} className="group">
              <TableCell className={`text-muted-foreground whitespace-nowrap ${stickyMonthCell}`}>
                {monthLabel(row.month)}
              </TableCell>
              {grid.columns.map((column) => {
                const cell = row.cells[column.id];
                return (
                  <TableCell key={column.id} className="tabular text-right whitespace-nowrap">
                    {cell ? (
                      <button
                        type="button"
                        className={clickableCell}
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
                  className={clickableCell}
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
                  className={clickableCell}
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
                  className={cn(clickableCell, negativeCell(row.grossSavingsCents))}
                  onClick={() => openBreakdown(`Gross Savings — ${monthLabel(row.month)} ${year}`, row.month, row)}
                >
                  {money(row.grossSavingsCents)}
                </button>
              </TableCell>
            </TableRow>
          ))}

          <TableRow className="bg-muted/40 border-t-2 font-semibold">
            <TableCell className={`bg-muted/40 ${stickyMonthCell}`}>Total</TableCell>
            {grid.columns.map((column) => {
              const cell = grid.yearTotal.cells[column.id];
              return (
                <TableCell key={column.id} className="tabular text-right whitespace-nowrap">
                  {cell ? (
                    <button
                      type="button"
                      className={clickableCell}
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
                className={clickableCell}
                onClick={() => openTransactions(`Total Expenditure — ${year}`, null, { kind: 'expenditure' }, false)}
              >
                {money(grid.yearTotal.totalExpenditureCents)}
              </button>
            </TableCell>
            <TableCell className="tabular text-right whitespace-nowrap">
              <button
                type="button"
                className={clickableCell}
                onClick={() => openTransactions(`Income — ${year}`, null, { kind: 'income' }, true)}
              >
                {money(grid.yearTotal.incomeCents)}
              </button>
            </TableCell>
            <TableCell className="tabular text-right whitespace-nowrap">
              <button
                type="button"
                className={cn(clickableCell, negativeCell(grid.yearTotal.grossSavingsCents))}
                onClick={() => openBreakdown(`Gross Savings — ${year}`, null, grid.yearTotal)}
              >
                {money(grid.yearTotal.grossSavingsCents)}
              </button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>

      <Dialog open={dialog !== null} onOpenChange={(open) => (open ? null : closeDialog())}>
        {/* `sm:max-w-5xl` — not the unprefixed `max-w-5xl` it looks like it should
            be: DialogContent's own base class is `sm:max-w-lg`, and Tailwind
            emits responsive variants AFTER their unprefixed base utility in the
            stylesheet regardless of className order, so an unprefixed override
            here would silently lose to `sm:max-w-lg` at any viewport ≥640px.
            Confirmed by screenshot — an earlier `max-w-4xl` here rendered at
            ~512px (lg), not 896px (4xl), until this was corrected. */}
        <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-5xl">
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
                // `min-h-0` overrides the flex-item default of `min-height: auto`,
                // the vertical-axis twin of the app's own documented `min-w-0`
                // gotcha — without it this pane refuses to shrink below its
                // content height and the dialog itself grows past the viewport
                // instead of scrolling in here, the ONE scroll surface (the
                // Table's own horizontal scroll, from the shared primitive, is
                // the only other one, and it is contained the same way it is
                // everywhere else in the app).
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Merchant</TableHead>
                        <TableHead>Note</TableHead>
                        <TableHead>Category</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.transactions.map((transaction) => {
                        const rowName = transaction.normalizedMerchant ?? transaction.originalDescription;
                        return (
                          <TableRow key={transaction.id}>
                            <TableCell className="text-muted-foreground whitespace-nowrap">
                              {formatHumanDate(transaction.transactionDate)}
                            </TableCell>
                            <TableCell className="max-w-40">
                              <InlineEditText
                                value={transaction.normalizedMerchant ?? ''}
                                onSave={(value) => saveMerchant(transaction, value)}
                                ariaLabel={`Merchant for ${rowName}`}
                                placeholder="(no merchant)"
                              />
                              <div className="text-muted-foreground truncate text-xs" title={transaction.originalDescription}>
                                {transaction.originalDescription}
                              </div>
                            </TableCell>
                            <TableCell className="max-w-32">
                              <InlineEditText
                                value={transaction.notes ?? ''}
                                onSave={(value) => saveNote(transaction, value)}
                                ariaLabel={`Note for ${rowName}`}
                                placeholder="Add note"
                              />
                            </TableCell>
                            <TableCell>
                              <Select
                                value={transaction.categoryId ?? 'none'}
                                onValueChange={(value) => changeCategory(transaction, value === 'none' ? null : value)}
                              >
                                <SelectTrigger aria-label={`Category for ${rowName}`} className="h-8 w-36">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="none">Uncategorized</SelectItem>
                                  {categories.map((category) => (
                                    <SelectItem key={category.id} value={category.id}>
                                      {category.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </TableCell>
                            <TableCell>
                              <Select
                                value={transaction.transactionType}
                                onValueChange={(value) => changeType(transaction, value as ManualTransactionType)}
                              >
                                <SelectTrigger aria-label={`Type for ${rowName}`} className="h-8 w-40">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {MANUAL_TRANSACTION_TYPES.map((type) => (
                                    <SelectItem key={type} value={type}>
                                      {TRANSACTION_TYPE_LABELS[type]}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </TableCell>
                            <TableCell className="tabular text-right whitespace-nowrap">
                              {money(dialog.flipSign ? -transaction.amountCents : transaction.amountCents)}
                            </TableCell>
                          </TableRow>
                        );
                      })}
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
                  <dd className={cn('tabular', negativeCell(dialog.totals.grossSavingsCents))}>
                    {money(dialog.totals.grossSavingsCents)}
                  </dd>
                </div>
              </dl>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
