'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { EmptyState } from '@/components/finance/empty-state';
import { Money } from '@/components/finance/money';
import { StatusBadge, type StatusTone } from '@/components/finance/status-badge';
import type { FinanceCategory } from '@/server/db/finance/categories';
import type {
  LedgerFilters,
  LedgerPage,
  LedgerSummary,
  LedgerTransaction,
} from '@/server/db/finance/transactions';
import { MANUAL_TRANSACTION_TYPES, TRANSACTION_TYPE_LABELS, type ManualTransactionType } from '@/server/finance/classify/manual';
import { LEDGER_TRANSACTION_TYPES } from './filters';
import {
  updateTransactionCategoryAction,
  updateTransactionMerchantAction,
  updateTransactionNoteAction,
  updateTransactionTypeAction,
} from './actions';

const STATUS_LABELS: Record<string, string> = {
  all: 'All',
  needs_review: 'Needs review',
  auto: 'Auto-classified',
  confirmed: 'Confirmed',
};

const STATUS_TONE: Record<string, StatusTone> = {
  needs_review: 'attention',
  auto: 'neutral',
  confirmed: 'positive',
};

/** A category picker that includes ARCHIVED categories, labeled distinctly — unlike Review's, which only ever shows live ones. A historical ledger has to remain understandable even when a transaction's category was archived years later. */
function categoryLabel(category: FinanceCategory): string {
  return category.archivedAt ? `${category.name} (archived)` : category.name;
}

export function TransactionsTable({
  page,
  categories,
  years,
  filters,
  summary,
}: {
  readonly page: LedgerPage;
  readonly categories: readonly FinanceCategory[];
  readonly years: readonly number[];
  readonly filters: LedgerFilters;
  readonly summary: LedgerSummary;
}): React.ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [rows, setRows] = useState(page.rows);
  const [syncedFrom, setSyncedFrom] = useState(page.rows);
  const [searchDraft, setSearchDraft] = useState(filters.search ?? '');
  const [, startTransition] = useTransition();

  // A filter change or `router.refresh()` after an edit delivers a NEW
  // `page.rows` reference here — see review-queue.tsx for why this runs
  // during render rather than a `useEffect`.
  if (page.rows !== syncedFrom) {
    setSyncedFrom(page.rows);
    setRows(page.rows);
  }

  function setFilter(key: string, value: string | undefined): void {
    const params = new URLSearchParams(searchParams.toString());
    if (!value || value === 'all') params.delete(key);
    else params.set(key, value);
    params.delete('page'); // any filter change starts back at page 1
    router.push(params.size > 0 ? `${pathname}?${params.toString()}` : pathname);
  }

  function setPage(nextPage: number): void {
    const params = new URLSearchParams(searchParams.toString());
    if (nextPage <= 1) params.delete('page');
    else params.set('page', String(nextPage));
    router.push(params.size > 0 ? `${pathname}?${params.toString()}` : pathname);
  }

  function submitSearch(): void {
    setFilter('q', searchDraft.trim() || undefined);
  }

  function changeCategory(row: LedgerTransaction, categoryId: string | null): void {
    const previous = row.categoryId;
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, categoryId } : r)));

    startTransition(async () => {
      const result = await updateTransactionCategoryAction(row.id, categoryId, false);
      if (!result.ok) {
        toast.error(result.error);
        setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, categoryId: previous } : r)));
        return;
      }
      toast.success('Updated');
      router.refresh();
    });
  }

  function changeType(row: LedgerTransaction, transactionType: ManualTransactionType): void {
    const previous = row.transactionType;
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, transactionType } : r)));

    startTransition(async () => {
      const result = await updateTransactionTypeAction(row.id, transactionType);
      if (!result.ok) {
        toast.error(result.error);
        setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, transactionType: previous } : r)));
        return;
      }
      toast.success('Updated');
      router.refresh();
    });
  }

  function saveMerchant(row: LedgerTransaction, value: string): void {
    const trimmed = value.trim();
    if (trimmed === (row.normalizedMerchant ?? '')) return;
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, normalizedMerchant: trimmed || null } : r)));

    startTransition(async () => {
      const result = await updateTransactionMerchantAction(row.id, trimmed);
      if (!result.ok) toast.error(result.error);
    });
  }

  function saveNote(row: LedgerTransaction, value: string): void {
    const trimmed = value.trim();
    if (trimmed === (row.notes ?? '')) return;
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, notes: trimmed || null } : r)));

    startTransition(async () => {
      const result = await updateTransactionNoteAction(row.id, trimmed);
      if (!result.ok) toast.error(result.error);
    });
  }

  const exportParams = new URLSearchParams(searchParams.toString());
  exportParams.delete('page'); // export always reflects the current filter, never the on-screen page
  const exportHref = `/finance/transactions/export?${exportParams.toString()}`;

  const totalPages = Math.max(1, Math.ceil(page.totalCount / 100));
  const currentPage = Math.min(totalPages, Math.max(1, Math.floor((searchParams.get('page') ? Number(searchParams.get('page')) : 1))));

  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <FilterSelect
          label="Year"
          value={String(filters.year)}
          onChange={(value) => setFilter('year', value)}
          options={years.map((y) => [String(y), String(y)] as [string, string])}
        />
        <FilterSelect
          label="Month"
          value={filters.month ? String(filters.month) : 'all'}
          onChange={(value) => setFilter('month', value === 'all' ? undefined : value)}
          options={[
            ['all', 'All months'],
            ...Array.from({ length: 12 }, (_, i) => [String(i + 1), MONTH_NAMES[i]!] as [string, string]),
          ]}
        />
        <FilterSelect
          label="Category"
          value={filters.categoryId ?? 'all'}
          onChange={(value) => setFilter('category', value === 'all' ? undefined : value)}
          options={[
            ['all', 'All categories'],
            ['uncategorized', 'Uncategorized'],
            ...categories.map((c) => [c.id, categoryLabel(c)] as [string, string]),
          ]}
        />
        <FilterSelect
          label="Type"
          value={filters.transactionType ?? 'all'}
          onChange={(value) => setFilter('type', value === 'all' ? undefined : value)}
          options={[
            ['all', 'All types'],
            ...LEDGER_TRANSACTION_TYPES.map((t) => [t, TRANSACTION_TYPE_LABELS[t] ?? t] as [string, string]),
          ]}
        />
        <FilterSelect
          label="Status"
          value={filters.reviewStatus ?? 'all'}
          onChange={(value) => setFilter('status', value === 'all' ? undefined : value)}
          options={[
            ['all', STATUS_LABELS.all!],
            ['needs_review', STATUS_LABELS.needs_review!],
            ['auto', STATUS_LABELS.auto!],
            ['confirmed', STATUS_LABELS.confirmed!],
          ]}
        />
        <div className="space-y-1">
          <span className="text-muted-foreground block text-xs">Search</span>
          <div className="flex gap-1">
            <Input
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submitSearch();
              }}
              placeholder="Merchant or description"
              aria-label="Search merchant or description"
              className="h-8 w-48"
            />
            <Button variant="outline" size="sm" className="h-8" onClick={submitSearch}>
              Search
            </Button>
          </div>
        </div>
      </div>

      <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span>
          {summary.totalCount} transaction{summary.totalCount === 1 ? '' : 's'}
        </span>
        {summary.needsReviewCount > 0 ? <span>{summary.needsReviewCount} need review</span> : null}
        {summary.excludedCount > 0 ? (
          <span>
            {summary.excludedCount} transfer/card payment transaction{summary.excludedCount === 1 ? '' : 's'} excluded
            from Monthly
          </span>
        ) : null}
        <a href={exportHref} className="ml-auto font-medium underline underline-offset-2">
          Export {summary.totalCount} transaction{summary.totalCount === 1 ? '' : 's'}
        </a>
      </div>

      {rows.length === 0 ? (
        <EmptyState>No transactions match this filter.</EmptyState>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Merchant</TableHead>
                <TableHead>Note</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const rowName = row.normalizedMerchant ?? row.originalDescription;
                return (
                  <TableRow key={row.id}>
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {row.transactionDate}
                    </TableCell>
                    <TableCell className="w-48">
                      <Input
                        defaultValue={row.normalizedMerchant ?? ''}
                        aria-label={`Merchant for ${rowName}`}
                        className="h-8"
                        onBlur={(event) => saveMerchant(row, event.target.value)}
                      />
                      <div className="text-muted-foreground truncate text-xs" title={row.originalDescription}>
                        {row.originalDescription}
                      </div>
                    </TableCell>
                    <TableCell className="w-40">
                      <Input
                        defaultValue={row.notes ?? ''}
                        aria-label={`Note for ${rowName}`}
                        placeholder="Optional"
                        className="h-8"
                        onBlur={(event) => saveNote(row, event.target.value)}
                      />
                    </TableCell>
                    <TableCell>
                      <Money valueCents={row.amountCents} />
                    </TableCell>
                    <TableCell>
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
                              {categoryLabel(category)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={row.transactionType}
                        onValueChange={(value) => changeType(row, value as ManualTransactionType)}
                      >
                        <SelectTrigger aria-label={`Type for ${rowName}`} className="h-8 w-44">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {MANUAL_TRANSACTION_TYPES.includes(row.transactionType as ManualTransactionType) ? null : (
                            <SelectItem value={row.transactionType} disabled>
                              {TRANSACTION_TYPE_LABELS[row.transactionType] ?? row.transactionType}
                            </SelectItem>
                          )}
                          {MANUAL_TRANSACTION_TYPES.map((type) => (
                            <SelectItem key={type} value={type}>
                              {TRANSACTION_TYPE_LABELS[type]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={STATUS_TONE[row.reviewStatus] ?? 'muted'}>
                        {STATUS_LABELS[row.reviewStatus] ?? row.reviewStatus}
                      </StatusBadge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              Page {currentPage} of {totalPages} — {page.totalCount} total
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage <= 1}
                onClick={() => setPage(currentPage - 1)}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage >= totalPages}
                onClick={() => setPage(currentPage + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

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
