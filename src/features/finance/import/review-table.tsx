'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FilterChip } from '@/components/ui/filter-chip';
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
import type { FinanceCategory } from '@/server/db/finance/categories';
import type {
  CommitResult,
  FinanceImportRowView,
  ImportStatus,
  PriorFileUpload,
} from '@/server/db/finance/imports';
import { MANUAL_TRANSACTION_TYPES, TRANSACTION_TYPE_LABELS } from '@/server/finance/classify/manual';
import { cents, format } from '@/server/finance/money';
import {
  commitImportAction,
  discardImportAction,
  updateRowCategoryAction,
  updateRowDecisionAction,
  updateRowMerchantAction,
  updateRowNoteAction,
  updateRowTypeAction,
} from './actions';
import { BUCKET_LABELS, BUCKET_TONE, type RowBucket, rowBucket, rowReason } from './row-status';

/** The Type select's "no override" state — never sent to the server; picking a real type is. */
const AUTO_TYPE = '__auto__';

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
 * The M5 review screen: preview, edit, include/exclude, commit — the one
 * canonical import review UI (see `import-sheet.tsx`'s own doc comment for
 * why the Sheet no longer renders this inline).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `willImport` recomputes from local state on every render rather than being
 * server-supplied, so any edit updates the commit button's count immediately.
 *
 * Merchant and note edits save on blur, not per keystroke — both are free
 * text, unlike the discrete category/type/decision choices, which save
 * immediately on selection.
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
  const [filter, setFilter] = useState<'all' | RowBucket>('all');
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<CommitResult | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  // Checked BEFORE `status`, deliberately. `commitImportAction` calls
  // `revalidatePath()`, which re-renders this Server Component subtree with
  // the now-`committed` status — if that check ran first, the "Import
  // complete" summary below would never be seen: the fresh `status` prop
  // would win the race against the local `result` state on the very re-render
  // that was supposed to display it.
  if (result) {
    return (
      <div className="bg-card mt-8 max-w-md space-y-3 rounded-md p-6 text-sm">
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
      <div className="mt-8 space-y-6">
        <p className="text-muted-foreground text-sm">This import was already committed. Nothing left to review.</p>
        <BackupReminder />
      </div>
    );
  }
  if (status === 'discarded') {
    return <p className="text-muted-foreground mt-8 text-sm">This import was discarded.</p>;
  }

  function patchRow(rowId: string, patch: Partial<FinanceImportRowView>): void {
    setRows((prev) => prev.map((row) => (row.id === rowId ? { ...row, ...patch } : row)));
  }

  function setDecision(rowId: string, decision: 'include' | 'exclude'): void {
    patchRow(rowId, { decision, decisionOverridden: true });
    startTransition(async () => {
      const outcome = await updateRowDecisionAction(importId, rowId, decision);
      if (!outcome.ok) {
        toast.error(outcome.error);
        const reverted = decision === 'include' ? 'exclude' : 'include';
        patchRow(rowId, { decision: reverted });
      }
    });
  }

  function setCategory(rowId: string, categoryId: string | null): void {
    const previous = rows.find((row) => row.id === rowId)?.categoryId ?? null;
    patchRow(rowId, {
      categoryId,
      categorizationSource: categoryId === null ? null : 'manual',
    });
    startTransition(async () => {
      const outcome = await updateRowCategoryAction(importId, rowId, categoryId);
      if (!outcome.ok) {
        toast.error(outcome.error);
        patchRow(rowId, { categoryId: previous });
      }
    });
  }

  function setType(rowId: string, value: string): void {
    if (value === AUTO_TYPE) return; // display-only sentinel — never sent, see AUTO_TYPE's own comment.
    const type = value as (typeof MANUAL_TRANSACTION_TYPES)[number];
    const previous = rows.find((row) => row.id === rowId);
    patchRow(rowId, { suggestedType: type as 'transfer' | 'credit_card_payment' | null, typeOverridden: true });
    startTransition(async () => {
      const outcome = await updateRowTypeAction(importId, rowId, type);
      if (!outcome.ok) {
        toast.error(outcome.error);
        if (previous) patchRow(rowId, { suggestedType: previous.suggestedType, typeOverridden: previous.typeOverridden });
      }
    });
  }

  function saveMerchant(rowId: string, value: string): void {
    const previous = rows.find((row) => row.id === rowId)?.normalizedMerchant ?? null;
    const trimmed = value.trim();
    if (trimmed === (previous ?? '')) return; // nothing actually changed — don't fire a needless save.
    startTransition(async () => {
      const outcome = await updateRowMerchantAction(importId, rowId, value);
      if (!outcome.ok) {
        toast.error(outcome.error);
        patchRow(rowId, { normalizedMerchant: previous });
      }
    });
  }

  function saveNote(rowId: string, value: string): void {
    const previous = rows.find((row) => row.id === rowId)?.reviewNote ?? null;
    const trimmed = value.trim();
    if (trimmed === (previous ?? '')) return;
    startTransition(async () => {
      const outcome = await updateRowNoteAction(importId, rowId, trimmed === '' ? null : trimmed);
      if (!outcome.ok) {
        toast.error(outcome.error);
        patchRow(rowId, { reviewNote: previous });
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
    startTransition(async () => {
      const outcome = await discardImportAction(importId);
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      router.push('/finance/monthly');
    });
  }

  const bucketed = rows.map((row) => ({ row, bucket: rowBucket(row) }));
  const counts: Record<RowBucket, number> = { ready: 0, attention: 0, duplicate: 0, excluded: 0 };
  for (const { bucket } of bucketed) counts[bucket] += 1;

  const visible = filter === 'all' ? bucketed : bucketed.filter((entry) => entry.bucket === filter);
  const willImport = rows.filter((row) => row.decision === 'include' && row.parseError === null).length;

  return (
    <div className="space-y-4">
      {priorUpload ? (
        <div role="status" className="bg-muted/50 rounded-md p-3 text-sm">
          {priorUploadMessage(priorUpload)}
        </div>
      ) : null}

      <div className="bg-background sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b py-3">
        <FilterChip label="All" count={rows.length} active={filter === 'all'} onClick={() => setFilter('all')} />
        {(Object.keys(BUCKET_LABELS) as RowBucket[]).map((bucket) => (
          <FilterChip
            key={bucket}
            label={BUCKET_LABELS[bucket]}
            count={counts[bucket]}
            active={filter === bucket}
            onClick={() => setFilter(bucket)}
          />
        ))}
        <span className="text-muted-foreground ml-auto text-sm">
          {filter === 'all' ? 'Showing all rows' : `Showing ${BUCKET_LABELS[filter]} only`}
        </span>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">Include</TableHead>
            <TableHead>Date</TableHead>
            <TableHead>Merchant</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Note</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map(({ row, bucket }) => {
            const failed = row.parseError !== null;
            const rowName = row.normalizedMerchant ?? row.description ?? `row ${row.rowNumber}`;
            // Pre-fills with item 2/2a's preview when present, editable either
            // way — picking any value here (even re-confirming the same one)
            // sets typeOverridden via setType().
            const typeValue = row.suggestedType ?? AUTO_TYPE;

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
                <TableCell className="w-64">
                  {failed ? (
                    <span className="text-destructive">{row.parseError}</span>
                  ) : (
                    <div className="max-w-64 space-y-1">
                      <Input
                        defaultValue={row.normalizedMerchant ?? ''}
                        aria-label={`Merchant for ${rowName}`}
                        className="h-8"
                        disabled={pending}
                        onBlur={(event) => saveMerchant(row.id, event.target.value)}
                      />
                      {/* The raw statement text, so a categorization decision can be made from it directly. */}
                      <div className="text-muted-foreground truncate text-xs" title={row.description ?? undefined}>
                        {row.description}
                      </div>
                    </div>
                  )}
                </TableCell>
                <TableCell className="tabular text-right whitespace-nowrap">
                  {row.amountCents === null ? '—' : format(cents(row.amountCents), { signed: true })}
                </TableCell>
                <TableCell>
                  <StatusBadge tone={BUCKET_TONE[bucket]}>{rowReason(row, bucket)}</StatusBadge>
                </TableCell>
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
                <TableCell>
                  <Select value={typeValue} disabled={failed} onValueChange={(value) => setType(row.id, value)}>
                    <SelectTrigger aria-label={`Type for ${rowName}`} className="h-8 w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={AUTO_TYPE}>Automatic</SelectItem>
                      {MANUAL_TRANSACTION_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {TRANSACTION_TYPE_LABELS[type]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="min-w-40">
                  <Input
                    defaultValue={row.reviewNote ?? ''}
                    aria-label={`Note for ${rowName}`}
                    placeholder="Optional"
                    className="h-8"
                    disabled={failed || pending}
                    onBlur={(event) => saveNote(row.id, event.target.value)}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <div className="bg-background sticky bottom-0 flex gap-2 border-t py-3">
        <Button onClick={commit} disabled={pending || willImport === 0}>
          {pending ? 'Working…' : `Import ${willImport} transaction${willImport === 1 ? '' : 's'}`}
        </Button>
        <Button variant="ghost" onClick={() => setConfirmingDiscard(true)} disabled={pending}>
          Discard
        </Button>
      </div>

      <ConfirmDialog
        open={confirmingDiscard}
        onOpenChange={setConfirmingDiscard}
        title="Discard this import?"
        description="Nothing has been added to your history yet."
        confirmLabel="Discard"
        destructive
        onConfirm={discard}
      />
    </div>
  );
}

/**
 * The backup prompt, shown once an import is committed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A REMINDER AND NOT AUTOMATION.
 *
 * `docs/DEPLOYMENT.md` sets the policy: an independent logical backup taken by
 * hand at two triggers — after a meaningful import, and before a schema
 * migration — with no new infrastructure. Supabase's free plan has no managed
 * backups, and the old automated restic pipeline went away with the VPS.
 *
 * A manual policy's only real failure mode is forgetting, and a completed
 * import IS trigger #1. So the app says so at the exact moment it applies,
 * rather than relying on the owner to remember a document. It prints the
 * command instead of running anything: this app never touches the filesystem
 * or shells out, and a backup that the app took of itself, stored next to
 * itself, would not be a backup anyway.
 * ─────────────────────────────────────────────────────────────────────────────
 */
function BackupReminder(): React.ReactElement {
  const command = 'pg_dump "$DATABASE_URL" -Fc -f "burmy-$(date +%F).dump"';

  return (
    <div className="bg-card rounded-md p-6">
      <h2 className="font-display text-base font-medium">Back this up</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        A real import is one of the two moments worth a backup. Run this against the direct (non-pooled) connection
        string, and keep the file somewhere other than the database it came from.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <code className="bg-muted min-w-0 flex-1 truncate rounded-md px-3 py-2 font-mono text-xs">{command}</code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            // `writeText` rejects without a secure context or clipboard
            // permission. The command is visible either way, so a failure here
            // costs the owner a manual selection, not the information.
            navigator.clipboard.writeText(command).then(
              () => toast.success('Command copied'),
              () => toast.error('Could not copy — select the command instead.'),
            );
          }}
        >
          Copy
        </Button>
      </div>
    </div>
  );
}
