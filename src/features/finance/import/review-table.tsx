'use client';

import { useRouter } from 'next/navigation';
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
import type { FinanceCategory } from '@/server/db/finance/categories';
import type {
  CommitResult,
  FinanceImportRowView,
  ImportStatus,
  PriorFileUpload,
} from '@/server/db/finance/imports';
import { cents, format } from '@/server/finance/money';
import {
  commitImportAction,
  discardImportAction,
  updateRowCategoryAction,
  updateRowDecisionAction,
} from './actions';

type RowLabel = 'new' | 'duplicate' | 'failed';

function rowLabel(row: FinanceImportRowView): RowLabel {
  if (row.parseError !== null) return 'failed';
  if (row.duplicateOfTransactionId !== null) return 'duplicate';
  return 'new';
}

const STATUS_STYLES: Record<RowLabel, string> = {
  new: 'text-green-700 dark:text-green-400',
  duplicate: 'text-muted-foreground',
  failed: 'text-destructive',
};

const STATUS_TEXT: Record<RowLabel, string> = {
  new: 'New',
  duplicate: 'Already imported',
  failed: 'Needs attention',
};

/**
 * Only a `committed` prior upload is ever called "already imported" — a
 * `review` or `discarded` match was never actually imported, and saying so
 * would be a lie the owner has no way to check. See docs/FINANCE.md.
 */
function priorUploadMessage(prior: PriorFileUpload): string {
  switch (prior.status) {
    case 'committed': {
      const when = prior.committedAt ? new Date(prior.committedAt).toLocaleDateString() : 'earlier';
      return `You already imported this exact file, on ${when}.`;
    }
    case 'review':
      return 'You already uploaded this exact file — that import is still awaiting review.';
    case 'discarded':
      return 'You uploaded this exact file before and discarded that import.';
    default:
      return '';
  }
}

/**
 * The M5 review screen: preview, categorize, include/exclude, commit.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Each row shows the normalized merchant AND the raw statement description
 * beneath it — a categorization decision needs the real text, and the merchant
 * name has already been stripped of location and reference noise.
 *
 * `willImport` recomputes from local state on every render rather than being
 * server-supplied, so toggling a row's checkbox updates the commit button's
 * count immediately.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function ImportReviewTable({
  importId,
  status,
  rows: initialRows,
  categories,
  priorUpload,
}: {
  readonly importId: string;
  readonly status: ImportStatus;
  readonly rows: readonly FinanceImportRowView[];
  readonly categories: readonly FinanceCategory[];
  readonly priorUpload: PriorFileUpload | null;
}): React.ReactElement {
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<CommitResult | null>(null);

  // Checked BEFORE `status`, deliberately. `commitImportAction` calls
  // `revalidatePath()`, which re-renders this Server Component subtree with
  // the now-`committed` status — if that check ran first, the "Import
  // complete" summary below would never be seen: the fresh `status` prop
  // would win the race against the local `result` state on the very re-render
  // that was supposed to display it.
  if (result) {
    return (
      <div className="mt-8 max-w-md space-y-3 rounded-md border p-4 text-sm">
        <p className="font-medium">Import complete.</p>
        <ul className="text-muted-foreground list-disc space-y-1 pl-4">
          <li>
            {result.importedCount} transaction{result.importedCount === 1 ? '' : 's'} added
          </li>
          <li>{result.skippedDuplicateCount} skipped as already imported</li>
          {result.autoClassifiedCount > 0 ? (
            <li>
              {result.autoClassifiedCount} categorized or classified automatically — nothing to review
            </li>
          ) : null}
          {result.skippedFailedCount > 0 ? (
            <li>{result.skippedFailedCount} needed attention and were not imported</li>
          ) : null}
          {result.demotedByRaceCount > 0 ? (
            <li>
              {result.demotedByRaceCount} row{result.demotedByRaceCount === 1 ? '' : 's'} turned out to
              already be imported by another import committed at the same time, and{' '}
              {result.demotedByRaceCount === 1 ? 'was' : 'were'} skipped.
            </li>
          ) : null}
        </ul>
        <Button size="sm" onClick={() => router.push('/finance/monthly')}>
          Back to Finance
        </Button>
      </div>
    );
  }

  if (status === 'committed') {
    return (
      <p className="text-muted-foreground mt-8 text-sm">
        This import was already committed. Nothing left to review.
      </p>
    );
  }
  if (status === 'discarded') {
    return <p className="text-muted-foreground mt-8 text-sm">This import was discarded.</p>;
  }

  function setDecision(rowId: string, decision: 'include' | 'exclude'): void {
    setRows((prev) => prev.map((row) => (row.id === rowId ? { ...row, decision } : row)));
    startTransition(async () => {
      const outcome = await updateRowDecisionAction(importId, rowId, decision);
      if (!outcome.ok) {
        toast.error(outcome.error);
        const reverted = decision === 'include' ? 'exclude' : 'include';
        setRows((prev) => prev.map((row) => (row.id === rowId ? { ...row, decision: reverted } : row)));
      }
    });
  }

  function setCategory(rowId: string, categoryId: string | null): void {
    const previous = rows.find((row) => row.id === rowId)?.categoryId ?? null;
    setRows((prev) => prev.map((row) => (row.id === rowId ? { ...row, categoryId } : row)));
    startTransition(async () => {
      const outcome = await updateRowCategoryAction(importId, rowId, categoryId);
      if (!outcome.ok) {
        toast.error(outcome.error);
        setRows((prev) => prev.map((row) => (row.id === rowId ? { ...row, categoryId: previous } : row)));
      }
    });
  }

  function commit(): void {
    startTransition(async () => {
      const outcome = await commitImportAction(importId);
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      setResult(outcome.summary);
    });
  }

  function discard(): void {
    if (!window.confirm('Discard this import? Nothing has been added to your history yet.')) return;
    startTransition(async () => {
      const outcome = await discardImportAction(importId);
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      router.push('/finance/monthly');
    });
  }

  const counts = {
    new: rows.filter((row) => rowLabel(row) === 'new').length,
    duplicate: rows.filter((row) => rowLabel(row) === 'duplicate').length,
    failed: rows.filter((row) => rowLabel(row) === 'failed').length,
  };
  const willImport = rows.filter((row) => row.decision === 'include' && row.parseError === null).length;

  return (
    <div className="mt-8 space-y-4">
      {priorUpload ? (
        <div role="status" className="bg-muted/50 rounded-md border p-3 text-sm">
          {priorUploadMessage(priorUpload)}
        </div>
      ) : null}

      <p className="text-muted-foreground text-sm">
        {counts.new} new · {counts.duplicate} already imported · {counts.failed} need attention ·{' '}
        {willImport} will import
      </p>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">Include</TableHead>
            <TableHead>Date</TableHead>
            <TableHead>Merchant</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Category</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const label = rowLabel(row);
            const failed = label === 'failed';
            const rowName = row.normalizedMerchant ?? row.description ?? `row ${row.rowNumber}`;

            return (
              <TableRow key={row.id}>
                <TableCell>
                  <input
                    type="checkbox"
                    aria-label={`Include ${rowName}`}
                    checked={row.decision === 'include'}
                    disabled={failed || pending}
                    onChange={(event) => setDecision(row.id, event.target.checked ? 'include' : 'exclude')}
                  />
                </TableCell>
                <TableCell className="text-muted-foreground whitespace-nowrap">
                  {row.transactionDate ?? '—'}
                </TableCell>
                <TableCell>
                  {failed ? (
                    <span className="text-destructive">{row.parseError}</span>
                  ) : (
                    <div>
                      <div className="font-medium">{row.normalizedMerchant}</div>
                      {/* The raw statement text, so a categorization decision can be made from it directly. */}
                      <div className="text-muted-foreground text-xs">{row.description}</div>
                    </div>
                  )}
                </TableCell>
                <TableCell className="tabular text-right whitespace-nowrap">
                  {row.amountCents === null ? '—' : format(cents(row.amountCents), { signed: true })}
                </TableCell>
                <TableCell className={STATUS_STYLES[label]}>{STATUS_TEXT[label]}</TableCell>
                <TableCell>
                  <Select
                    value={row.categoryId ?? 'none'}
                    disabled={failed}
                    onValueChange={(value) => setCategory(row.id, value === 'none' ? null : value)}
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
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <div className="flex gap-2">
        <Button onClick={commit} disabled={pending || willImport === 0}>
          {pending ? 'Working…' : `Import ${willImport} transaction${willImport === 1 ? '' : 's'}`}
        </Button>
        <Button variant="ghost" onClick={discard} disabled={pending}>
          Discard
        </Button>
      </div>
    </div>
  );
}
