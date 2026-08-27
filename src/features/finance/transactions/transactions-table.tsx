'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { FilterBar, FilterField } from '@/components/ui/filter-bar';
import { FilterChip } from '@/components/ui/filter-chip';
import { FilterSelect } from '@/components/ui/filter-select';
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
import { InlineEditText } from '@/components/finance/inline-edit-text';
import { Money } from '@/components/finance/money';
import { StatusBadge, type StatusTone } from '@/components/finance/status-badge';
import { formatHumanDate } from '@/lib/format-date';
import type { FinanceCategory } from '@/server/db/finance/categories';
import type {
  LedgerFilters,
  MerchantRulePreview,
  LedgerPage,
  LedgerSummary,
  LedgerTransaction,
} from '@/server/db/finance/transactions';
import { MANUAL_TRANSACTION_TYPES, TRANSACTION_TYPE_LABELS, type ManualTransactionType } from '@/server/finance/classify/manual';
import { LEDGER_TRANSACTION_TYPES } from './filters';
import { MerchantRuleDialog } from './merchant-rule-dialog';
import {
  previewMerchantRuleAction,
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

/** Chip order, widest-scope first — matches the `StatusFacetCounts` keys exactly. */
const STATUS_CHIP_ORDER = ['all', 'needs_review', 'auto', 'confirmed'] as const;

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
  /** The pending "apply to this merchant's other transactions?" offer, or null. */
  const [rulePreview, setRulePreview] = useState<{ readonly preview: MerchantRulePreview; readonly categoryId: string } | null>(null);
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

      // Offered only on a real assignment, never on un-categorizing: "clear
      // this category everywhere" is a destructive bulk action nobody asked
      // for, and the whole point of the rule is to FILL Other, not empty a
      // category.
      if (result.ok && categoryId !== null) {
        const preview = await previewMerchantRuleAction(row.id, categoryId, previous);
        // Silent when there is nothing else from this merchant — a dialog
        // saying "0 other transactions" is an interruption, not information.
        if (preview.ok && preview.preview !== null && preview.preview.willMove.length + preview.preview.conflicting.length > 0) {
          setRulePreview({ preview: preview.preview, categoryId });
        }
      }

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

  // The export href is built by the PAGE now, not here — Export became a
  // header action alongside every other page-level action in the app.
  const totalPages = Math.max(1, Math.ceil(page.totalCount / 100));
  const currentPage = Math.min(totalPages, Math.max(1, Math.floor((searchParams.get('page') ? Number(searchParams.get('page')) : 1))));

  return (
    <div className="space-y-8">
      <FilterBar>
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
        <FilterField label="Search">
          <div className="flex gap-2">
            <Input
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submitSearch();
              }}
              placeholder="Merchant or description"
              aria-label="Search merchant or description"
              className="w-56"
            />
            <Button variant="outline" onClick={submitSearch}>
              Search
            </Button>
          </div>
        </FilterField>
      </FilterBar>

      {/* Status is CHIPS, not a dropdown: four short-labelled options with a
          count worth seeing without opening anything — the same rule Games'
          library already follows for status/platform. Type stays a dropdown
          beside it (seven options, labels as long as "Credit Card Payment",
          which would make an unreadably wide chip row).

          The counts are faceted — computed with every other filter applied
          but NOT the status filter, so selecting one status doesn't zero out
          the others. See `statusFacetCounts` in the DAL for why that matters. */}
      <div className="flex flex-wrap gap-2">
        {STATUS_CHIP_ORDER.map((value) => (
          <FilterChip
            key={value}
            label={STATUS_LABELS[value]!}
            count={summary.statusCounts[value]}
            active={(filters.reviewStatus ?? 'all') === value}
            onClick={() => setFilter('status', value === 'all' ? undefined : value)}
          />
        ))}
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
                      {formatHumanDate(row.transactionDate)}
                    </TableCell>
                    <TableCell className="max-w-48">
                      <InlineEditText
                        value={row.normalizedMerchant ?? ''}
                        onSave={(value) => saveMerchant(row, value)}
                        ariaLabel={`Merchant for ${rowName}`}
                        placeholder="(no merchant)"
                      />
                      <div className="text-muted-foreground truncate text-xs" title={row.originalDescription}>
                        {row.originalDescription}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-40">
                      <InlineEditText
                        value={row.notes ?? ''}
                        onSave={(value) => saveNote(row, value)}
                        ariaLabel={`Note for ${rowName}`}
                        placeholder="Add note"
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

      {/* Rendered from the ledger rather than from the row, so it survives
          `router.refresh()` re-rendering the table underneath it. */}
      <MerchantRuleDialog
        preview={rulePreview?.preview ?? null}
        categoryId={rulePreview?.categoryId ?? ''}
        categoryName={categories.find((c) => c.id === rulePreview?.categoryId)?.name ?? ''}
        onClose={() => {
          setRulePreview(null);
          router.refresh();
        }}
      />
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
