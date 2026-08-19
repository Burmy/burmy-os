'use client';

import { ChevronDown } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
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
import { Money } from '@/components/finance/money';
import { StatusBadge, type StatusTone } from '@/components/finance/status-badge';
import type { FinanceCategory } from '@/server/db/finance/categories';
import type { ReviewFilters, ReviewTransaction } from '@/server/db/finance/transactions';
import { MANUAL_TRANSACTION_TYPES, type ManualTransactionType } from '@/server/finance/classify/manual';
import {
  bulkUpdateCategoryAction,
  updateTransactionCategoryAction,
  updateTransactionTypeAction,
} from './actions';

const TYPE_LABELS: Record<string, string> = {
  expense: 'Expense',
  refund: 'Refund',
  fee: 'Fee',
  income: 'Income',
  transfer: 'Transfer',
  credit_card_payment: 'Credit Card Payment',
  investment: 'Investment',
};

const STATUS_LABELS: Record<string, string> = {
  needs_review: 'Needs review',
  auto: 'Auto-classified',
  confirmed: 'Confirmed',
  all: 'All',
};

/** Same tone convention `transactions-table.tsx` already uses — one visual language for review_status everywhere it appears. */
const STATUS_TONE: Record<string, StatusTone> = {
  needs_review: 'attention',
  auto: 'neutral',
  confirmed: 'positive',
};

/**
 * Today this only ever says one thing for `needs_review` — a category is the
 * only reason M5/M6 ever produce it — but it is written as a per-row
 * explanation rather than a hardcoded string so a future second reason does
 * not need a UI redesign, only another branch.
 */
function explainReview(row: ReviewTransaction): string {
  if (row.reviewStatus === 'needs_review') return 'No category assigned';
  if (row.reviewStatus === 'auto' && row.typeSource === 'counterpart_match') {
    return `Matched as ${TYPE_LABELS[row.transactionType] ?? row.transactionType}`;
  }
  if (row.reviewStatus === 'auto') return 'Categorized from history';
  return 'Confirmed';
}

export function ReviewQueue({
  transactions,
  categories,
  filters,
}: {
  readonly transactions: readonly ReviewTransaction[];
  readonly categories: readonly FinanceCategory[];
  readonly filters: ReviewFilters;
}): React.ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [rows, setRows] = useState(transactions);
  // Tracks the last `transactions` prop reference `rows` was synced from, so
  // the sync below runs DURING render (React's own recommended pattern for
  // "adjust state when a prop changes") rather than in a useEffect, which
  // would need a synchronous setState-in-effect the lint rule flags for
  // exactly the cascading-render reason.
  const [syncedFrom, setSyncedFrom] = useState(transactions);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [remember, setRemember] = useState<Record<string, boolean>>({});
  const [bulkCategoryId, setBulkCategoryId] = useState<string>('');
  const [bulkRemember, setBulkRemember] = useState(false);
  const [pending, startTransition] = useTransition();

  // Open by default only when a non-default filter is already narrowing the
  // list — otherwise the common case (the plain needs_review queue, usually
  // one or two rows) starts with no toolbar at all to look past.
  const hasActiveFilter = Boolean(
    (filters.status && filters.status !== 'needs_review') || filters.categoryId || filters.transactionType,
  );
  const [filtersOpen, setFiltersOpen] = useState(hasActiveFilter);

  // A filter change (URL navigation) or a `router.refresh()` after a mutation
  // both deliver a NEW `transactions` array reference here.
  if (transactions !== syncedFrom) {
    setSyncedFrom(transactions);
    setRows(transactions);
    setSelected(new Set());
  }

  function setFilter(key: string, value: string | undefined): void {
    const params = new URLSearchParams(searchParams.toString());
    if (!value || value === 'all') params.delete(key);
    else params.set(key, value);
    router.push(params.size > 0 ? `${pathname}?${params.toString()}` : pathname);
  }

  function changeCategory(row: ReviewTransaction, categoryId: string | null): void {
    const previous = row.categoryId;
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, categoryId } : r)));

    startTransition(async () => {
      const result = await updateTransactionCategoryAction(row.id, categoryId, remember[row.id] ?? false);
      if (!result.ok) {
        toast.error(result.error);
        setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, categoryId: previous } : r)));
        return;
      }
      toast.success('Updated');
      router.refresh();
    });
  }

  function changeType(row: ReviewTransaction, transactionType: ManualTransactionType): void {
    const previous = row.transactionType;
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, transactionType } : r)));

    startTransition(async () => {
      const result = await updateTransactionTypeAction(row.id, transactionType);
      if (!result.ok) {
        toast.error(result.error);
        setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, transactionType: previous } : r)));
        return;
      }
      toast.success(
        row.counterpartAccountName
          ? 'Updated — the linked transaction was unlinked and reset too'
          : 'Updated',
      );
      router.refresh();
    });
  }

  function applyBulk(): void {
    if (!bulkCategoryId || selected.size === 0) return;
    const ids = [...selected];

    startTransition(async () => {
      const result = await bulkUpdateCategoryAction(ids, bulkCategoryId, bulkRemember);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(`${result.updatedCount} transaction${result.updatedCount === 1 ? '' : 's'} updated`);
      setSelected(new Set());
      setBulkCategoryId('');
      setBulkRemember(false);
      router.refresh();
    });
  }

  function toggleSelected(id: string, checked: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  return (
    <div className="mt-8 space-y-4">
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setFiltersOpen((prev) => !prev)}
          aria-expanded={filtersOpen}
          className="text-muted-foreground -ml-2 h-8"
        >
          Filters
          <ChevronDown className={`size-3.5 transition-transform ${filtersOpen ? 'rotate-180' : ''}`} />
        </Button>

        {filtersOpen ? (
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <FilterSelect
              label="Status"
              value={filters.status ?? 'needs_review'}
              onChange={(value) => setFilter('status', value)}
              options={[
                ['needs_review', STATUS_LABELS.needs_review!],
                ['auto', STATUS_LABELS.auto!],
                ['confirmed', STATUS_LABELS.confirmed!],
                ['all', STATUS_LABELS.all!],
              ]}
            />
            <FilterSelect
              label="Category"
              value={filters.categoryId ?? 'all'}
              onChange={(value) => setFilter('category', value === 'all' ? undefined : value)}
              options={[
                ['all', 'All categories'],
                ['uncategorized', 'Uncategorized'],
                ...categories.map((c) => [c.id, c.name] as [string, string]),
              ]}
            />
            <FilterSelect
              label="Type"
              value={filters.transactionType ?? 'all'}
              onChange={(value) => setFilter('type', value === 'all' ? undefined : value)}
              options={[['all', 'All types'], ...MANUAL_TRANSACTION_TYPES.map((t) => [t, TYPE_LABELS[t]!] as [string, string])]}
            />
          </div>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <p className="text-muted-foreground mt-8 text-sm">Nothing here. You&apos;re caught up.</p>
      ) : (
        <>
          {selected.size > 0 ? (
            <div className="bg-muted/50 flex items-center gap-2 rounded-md border p-3 text-sm">
              <span>{selected.size} selected</span>
              <Select value={bulkCategoryId} onValueChange={setBulkCategoryId}>
                <SelectTrigger aria-label="Category for selected transactions" className="h-8 w-48">
                  <SelectValue placeholder="Choose a category" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <label className="text-muted-foreground flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={bulkRemember}
                  onChange={(event) => setBulkRemember(event.target.checked)}
                />
                Remember these merchants
              </label>
              <Button size="sm" disabled={!bulkCategoryId || pending} onClick={applyBulk}>
                Set category for {selected.size}
              </Button>
            </div>
          ) : null}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={selected.size === rows.length}
                    onChange={(event) =>
                      setSelected(event.target.checked ? new Set(rows.map((r) => r.id)) : new Set())
                    }
                  />
                </TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Merchant</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Why</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const rowName = row.normalizedMerchant ?? row.originalDescription;
                return (
                  <TableRow key={row.id}>
                    <TableCell>
                      <input
                        type="checkbox"
                        aria-label={`Select ${rowName}`}
                        checked={selected.has(row.id)}
                        onChange={(event) => toggleSelected(row.id, event.target.checked)}
                      />
                    </TableCell>
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {row.transactionDate}
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{row.normalizedMerchant}</div>
                      <div className="text-muted-foreground text-xs">{row.originalDescription}</div>
                    </TableCell>
                    <TableCell>
                      <Money valueCents={row.amountCents} />
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <Select
                          value={row.categoryId ?? 'none'}
                          onValueChange={(value) => changeCategory(row, value === 'none' ? null : value)}
                        >
                          <SelectTrigger aria-label={`Category for ${rowName}`} className="h-8 w-40">
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
                        <label className="text-muted-foreground flex items-center gap-1 text-xs">
                          <input
                            type="checkbox"
                            checked={remember[row.id] ?? false}
                            onChange={(event) =>
                              setRemember((prev) => ({ ...prev, [row.id]: event.target.checked }))
                            }
                          />
                          Remember for future imports
                        </label>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <Select
                          value={row.transactionType}
                          onValueChange={(value) => changeType(row, value as ManualTransactionType)}
                        >
                          <SelectTrigger aria-label={`Type for ${rowName}`} className="h-8 w-44">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {MANUAL_TRANSACTION_TYPES.map((type) => (
                              <SelectItem key={type} value={type}>
                                {TYPE_LABELS[type]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {row.counterpartAccountName ? (
                          <p className="text-muted-foreground text-xs">
                            Linked to {row.counterpartAccountName} — changing the type will unlink both.
                          </p>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <StatusBadge tone={STATUS_TONE[row.reviewStatus] ?? 'muted'}>
                          {STATUS_LABELS[row.reviewStatus] ?? row.reviewStatus}
                        </StatusBadge>
                        <span className="text-muted-foreground text-sm">{explainReview(row)}</span>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </>
      )}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly [string, string][];
}): React.ReactElement {
  return (
    <div className="space-y-1">
      <span className="text-muted-foreground block text-xs">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label} className="h-8 w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([optionValue, optionLabel]) => (
            <SelectItem key={optionValue} value={optionValue}>
              {optionLabel}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
