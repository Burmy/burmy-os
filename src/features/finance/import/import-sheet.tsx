'use client';

import { FileUp } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';

import { EmptyState } from '@/components/finance/empty-state';
import { Money } from '@/components/finance/money';
import { StatusBadge } from '@/components/finance/status-badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import type { FinanceAccount } from '@/server/db/finance/accounts';
import type { FinanceCategory } from '@/server/db/finance/categories';
import type {
  CommitResult,
  FinanceImportRowView,
  FinanceImportSummary,
  PriorFileUpload,
} from '@/server/db/finance/imports';
import {
  commitImportAction,
  detectStatementFormatAction,
  discardImportAction,
  getImportContextAction,
  updateRowCategoryAction,
  updateRowDecisionAction,
  uploadStatementAction,
} from './actions';

/**
 * Only a `committed` prior upload is ever called "already imported" — a
 * `review` or `discarded` match was never actually imported, and saying so
 * would be a lie the owner has no way to check. See docs/FINANCE.md. Same
 * wording as `review-table.tsx`'s `priorUploadMessage` (the resume-path
 * page), duplicated rather than shared — matching this codebase's existing
 * e2e-helper convention of light duplication over a shared module for
 * something this small.
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

const LAST_ACCOUNT_STORAGE_KEY = 'burmy:lastImportAccountId';

type RowGroup = 'attention' | 'ready' | 'duplicate';

/**
 * A row's presentation group inside the Sheet — distinct from `decision` and
 * `duplicateOfTransactionId`, which are the M5/M6 data this is read FROM, not
 * a replacement for it.
 *
 * "attention" = a parse failure (nothing to fix, just worth seeing) OR a new
 * row merchant memory could not suggest a category for. The second half is a
 * deliberate UX choice, not an M5/M6 rule: that row will become
 * `needs_review` the moment it is committed anyway, so surfacing it now — one
 * click away from a category — avoids a second, separate visit to
 * /finance/review for the exact same transaction.
 */
function rowGroup(row: FinanceImportRowView): RowGroup {
  if (row.parseError !== null) return 'attention';
  if (row.duplicateOfTransactionId !== null) return 'duplicate';
  if (row.categoryId === null) return 'attention';
  return 'ready';
}

export function ImportSheet({
  accounts,
  categories,
  inProgressImports,
}: {
  readonly accounts: readonly FinanceAccount[];
  readonly categories: readonly FinanceCategory[];
  readonly inProgressImports: readonly FinanceImportSummary[];
}): React.ReactElement {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Which account is currently in play, and what the owner still needs to
  // decide about it. `null` compatibleAccountIds means "not narrowed yet" —
  // distinct from an empty array, which means "detection ran and nothing
  // qualifies."
  const [accountId, setAccountId] = useState<string | null>(null);
  const [compatibleAccountIds, setCompatibleAccountIds] = useState<readonly string[] | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  // Explicit rather than derived from `accountId`: once detection finds more
  // than one compatible account, this panel must stay open until "Continue"
  // is clicked — picking an option in its own Select must not, by itself,
  // make the panel it lives in disappear.
  const [confirmingAccount, setConfirmingAccount] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [importId, setImportId] = useState<string | null>(null);
  const [rows, setRows] = useState<FinanceImportRowView[]>([]);
  const [priorUpload, setPriorUpload] = useState<PriorFileUpload | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [result, setResult] = useState<CommitResult | null>(null);

  const activeAccounts = accounts.filter((account) => account.isActive);

  function resetForOpen(): void {
    setError(null);
    setImportId(null);
    setRows([]);
    setPriorUpload(null);
    setShowAll(false);
    setResult(null);
    setPendingFile(null);
    setCompatibleAccountIds(null);
    setConfirmingAccount(false);

    if (activeAccounts.length === 1) {
      setAccountId(activeAccounts[0]!.id);
      return;
    }
    const remembered =
      typeof window === 'undefined' ? null : window.localStorage.getItem(LAST_ACCOUNT_STORAGE_KEY);
    setAccountId(remembered && activeAccounts.some((a) => a.id === remembered) ? remembered : null);
  }

  function handleOpenChange(next: boolean): void {
    if (next) resetForOpen();
    setOpen(next);
  }

  function rememberAccount(id: string): void {
    if (typeof window !== 'undefined') window.localStorage.setItem(LAST_ACCOUNT_STORAGE_KEY, id);
  }

  /** Stage the file against a known account — the real, authoritative call. */
  function stage(file: File, forAccountId: string): void {
    setError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set('file', file);
      formData.set('accountId', forAccountId);
      const outcome = await uploadStatementAction(formData);
      if (!outcome.ok) {
        setError(outcome.error);
        setPendingFile(null);
        return;
      }
      rememberAccount(forAccountId);
      const context = await getImportContextAction(outcome.importId);
      setRows(context.rows);
      setPriorUpload(context.priorUpload);
      setImportId(outcome.importId);
      setPendingFile(null);
    });
  }

  function handleFile(file: File): void {
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setError('Only .csv files are accepted.');
      return;
    }

    // One active account: already selected in resetForOpen(). Go straight to
    // staging — no detection round trip needed to decide anything.
    if (activeAccounts.length <= 1) {
      if (!accountId) {
        setError('Add an account under Settings → Finance → Accounts before importing a statement.');
        return;
      }
      stage(file, accountId);
      return;
    }

    // Multiple accounts: compatibility can only be known after detection.
    setPendingFile(file);
    setError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set('file', file);
      const outcome = await detectStatementFormatAction(formData);
      if (!outcome.ok) {
        setError(outcome.error);
        setPendingFile(null);
        return;
      }

      setCompatibleAccountIds(outcome.compatibleAccountIds);

      if (outcome.compatibleAccountIds.length === 0) {
        setError("This file doesn't match any of your active accounts. Check the account list, or double-check the file.");
        setPendingFile(null);
        return;
      }

      if (outcome.compatibleAccountIds.length === 1) {
        const only = outcome.compatibleAccountIds[0]!;
        setAccountId(only);
        stage(file, only);
        return;
      }

      // Several compatible accounts remain — prefer the remembered one if it
      // still qualifies, otherwise the owner picks explicitly below. Either
      // way, an explicit "Continue" is still required — see
      // `confirmingAccount`'s own comment.
      const remembered =
        typeof window === 'undefined' ? null : window.localStorage.getItem(LAST_ACCOUNT_STORAGE_KEY);
      setAccountId(remembered && outcome.compatibleAccountIds.includes(remembered) ? remembered : null);
      setConfirmingAccount(true);
    });
  }

  function onFileInputChange(event: React.ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    if (file) handleFile(file);
    event.target.value = '';
  }

  function onDrop(event: React.DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  function confirmAccountAndStage(): void {
    if (!pendingFile || !accountId) return;
    setConfirmingAccount(false);
    stage(pendingFile, accountId);
  }

  function setDecision(rowId: string, decision: 'include' | 'exclude'): void {
    setRows((prev) => prev.map((row) => (row.id === rowId ? { ...row, decision } : row)));
    if (!importId) return;
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
    if (!importId) return;
    startTransition(async () => {
      const outcome = await updateRowCategoryAction(importId, rowId, categoryId);
      if (!outcome.ok) {
        toast.error(outcome.error);
        setRows((prev) => prev.map((row) => (row.id === rowId ? { ...row, categoryId: previous } : row)));
      }
    });
  }

  function commit(): void {
    if (!importId) return;
    startTransition(async () => {
      const outcome = await commitImportAction(importId);
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      setResult(outcome.summary);
      router.refresh();
    });
  }

  function discard(): void {
    if (!importId) return;
    startTransition(async () => {
      const outcome = await discardImportAction(importId);
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      handleOpenChange(false);
    });
  }

  function finish(): void {
    handleOpenChange(false);
  }

  const grouped = {
    attention: rows.filter((row) => rowGroup(row) === 'attention'),
    ready: rows.filter((row) => rowGroup(row) === 'ready'),
    duplicate: rows.filter((row) => rowGroup(row) === 'duplicate'),
  };
  const willImport = rows.filter((row) => row.decision === 'include' && row.parseError === null).length;

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger asChild>
        <Button size="sm">
          <FileUp className="size-4" />
          Import statement
        </Button>
      </SheetTrigger>
      <SheetContent className="flex flex-col gap-0 sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Import statement</SheetTitle>
          <SheetDescription>
            Select or drag a Bank of America CSV. It is parsed in memory and never written to disk.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-4">
          {result ? (
            <ImportDone result={result} />
          ) : importId ? (
            <ImportReview
              rows={rows}
              grouped={grouped}
              categories={categories}
              priorUpload={priorUpload}
              showAll={showAll}
              onShowAll={() => setShowAll(true)}
              onDecision={setDecision}
              onCategory={setCategory}
              pending={pending}
            />
          ) : (
            <ImportPicker
              activeAccounts={activeAccounts}
              accountId={accountId}
              onAccountChange={setAccountId}
              confirmingAccount={confirmingAccount}
              compatibleAccountIds={compatibleAccountIds}
              pendingFile={pendingFile}
              error={error}
              pending={pending}
              inProgressImports={inProgressImports}
              accounts={accounts}
              onDrop={onDrop}
              onBrowse={() => fileInputRef.current?.click()}
              fileInputRef={fileInputRef}
              onFileInputChange={onFileInputChange}
              onConfirmAccount={confirmAccountAndStage}
            />
          )}
        </div>

        {importId && !result ? (
          <SheetFooter>
            <Button variant="ghost" onClick={discard} disabled={pending}>
              Discard
            </Button>
            <Button onClick={commit} disabled={pending || willImport === 0}>
              {pending ? 'Working…' : `Import ${willImport} transaction${willImport === 1 ? '' : 's'}`}
            </Button>
          </SheetFooter>
        ) : null}

        {result ? (
          <SheetFooter>
            <Button onClick={finish}>Done</Button>
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function ImportPicker({
  activeAccounts,
  accounts,
  accountId,
  onAccountChange,
  confirmingAccount,
  compatibleAccountIds,
  pendingFile,
  error,
  pending,
  inProgressImports,
  onDrop,
  onBrowse,
  fileInputRef,
  onFileInputChange,
  onConfirmAccount,
}: {
  readonly activeAccounts: readonly FinanceAccount[];
  readonly accounts: readonly FinanceAccount[];
  readonly accountId: string | null;
  readonly onAccountChange: (id: string) => void;
  readonly confirmingAccount: boolean;
  readonly compatibleAccountIds: readonly string[] | null;
  readonly pendingFile: File | null;
  readonly error: string | null;
  readonly pending: boolean;
  readonly inProgressImports: readonly FinanceImportSummary[];
  readonly onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
  readonly onBrowse: () => void;
  readonly fileInputRef: React.RefObject<HTMLInputElement | null>;
  readonly onFileInputChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  readonly onConfirmAccount: () => void;
}): React.ReactElement {
  if (activeAccounts.length === 0) {
    return (
      <EmptyState>
        Add an account under Settings → Finance → Accounts before importing a statement.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-6">
      {confirmingAccount ? (
        <div className="space-y-3 rounded-md border p-4">
          <p className="text-sm">
            {pendingFile?.name} could belong to more than one account. Which one is it?
          </p>
          <Select {...(accountId ? { value: accountId } : {})} onValueChange={onAccountChange}>
            <SelectTrigger aria-label="Account" className="w-full">
              <SelectValue placeholder="Choose an account" />
            </SelectTrigger>
            <SelectContent>
              {accounts
                .filter((account) => compatibleAccountIds?.includes(account.id))
                .map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={onConfirmAccount} disabled={!accountId || pending}>
            {pending ? 'Working…' : 'Continue'}
          </Button>
        </div>
      ) : (
        <>
          {activeAccounts.length > 1 ? (
            <div className="space-y-2">
              <span className="text-muted-foreground text-xs">Account</span>
              <Select {...(accountId ? { value: accountId } : {})} onValueChange={onAccountChange}>
                <SelectTrigger aria-label="Account" className="w-full">
                  <SelectValue placeholder="Detected after you choose a file" />
                </SelectTrigger>
                <SelectContent>
                  {activeAccounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
            onClick={onBrowse}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') onBrowse();
            }}
            className="border-muted-foreground/25 hover:border-muted-foreground/50 hover:bg-muted/30 flex cursor-pointer flex-col items-center gap-2 rounded-md border-2 border-dashed p-10 text-center transition-colors"
          >
            <FileUp className="text-muted-foreground size-6" />
            <p className="text-sm font-medium">
              {pending ? 'Reading file…' : 'Drop a CSV here, or click to browse'}
            </p>
            <p className="text-muted-foreground text-xs">Bank of America checking, savings, or credit card export</p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            className="sr-only"
            aria-label="Statement file"
            onChange={onFileInputChange}
          />
        </>
      )}

      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}

      {inProgressImports.length > 0 ? (
        <div>
          <h2 className="text-sm font-semibold">Resume</h2>
          <p className="text-muted-foreground mt-1 text-xs">
            Staged earlier, not yet imported — nothing here has touched your transaction history.
          </p>
          <ul className="mt-2 space-y-1">
            {inProgressImports.map((imp) => {
              const account = accounts.find((candidate) => candidate.id === imp.accountId);
              return (
                <li key={imp.id}>
                  <Link
                    href={`/finance/import/${imp.id}`}
                    className="hover:bg-muted/50 flex items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors"
                  >
                    <span>
                      {imp.originalFilename}
                      <span className="text-muted-foreground"> — {account?.name ?? 'Unknown account'}</span>
                    </span>
                    <span className="text-muted-foreground text-xs">{imp.rowCount} rows</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ImportReview({
  rows,
  grouped,
  categories,
  priorUpload,
  showAll,
  onShowAll,
  onDecision,
  onCategory,
  pending,
}: {
  readonly rows: readonly FinanceImportRowView[];
  readonly grouped: Record<RowGroup, readonly FinanceImportRowView[]>;
  readonly categories: readonly FinanceCategory[];
  readonly priorUpload: PriorFileUpload | null;
  readonly showAll: boolean;
  readonly onShowAll: () => void;
  readonly onDecision: (rowId: string, decision: 'include' | 'exclude') => void;
  readonly onCategory: (rowId: string, categoryId: string | null) => void;
  readonly pending: boolean;
}): React.ReactElement {
  const settled = grouped.ready.length + grouped.duplicate.length;

  return (
    <div className="space-y-6">
      {priorUpload ? (
        <div role="status" className="bg-muted/50 rounded-md border p-3 text-sm">
          {priorUploadMessage(priorUpload)}
        </div>
      ) : null}

      <div className="grid grid-cols-3 gap-3 text-center">
        <SummaryStat label="Ready" value={grouped.ready.length} tone="positive" />
        <SummaryStat label="Duplicates" value={grouped.duplicate.length} tone="muted" />
        <SummaryStat label="Needs attention" value={grouped.attention.length} tone="attention" />
      </div>

      {grouped.attention.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Needs attention</h3>
          <RowTable
            rows={grouped.attention}
            categories={categories}
            onDecision={onDecision}
            onCategory={onCategory}
            pending={pending}
            showStatus
          />
        </div>
      ) : null}

      {settled > 0 ? (
        showAll ? (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Everything else ({settled})</h3>
            <RowTable
              rows={[...grouped.ready, ...grouped.duplicate]}
              categories={categories}
              onDecision={onDecision}
              onCategory={onCategory}
              pending={pending}
              showStatus
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={onShowAll}
            className="text-muted-foreground hover:text-foreground w-full rounded-md border border-dashed p-3 text-center text-sm transition-colors"
          >
            {settled} more already understood — no action needed. Show all rows
          </button>
        )
      ) : null}

      {rows.length === 0 ? <EmptyState>This file has no rows.</EmptyState> : null}
    </div>
  );
}

function SummaryStat({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: number;
  readonly tone: 'positive' | 'muted' | 'attention';
}): React.ReactElement {
  const toneClass =
    tone === 'positive'
      ? 'text-green-700 dark:text-green-400'
      : tone === 'attention'
        ? 'text-amber-700 dark:text-amber-400'
        : 'text-muted-foreground';
  return (
    <div className="rounded-md border p-3">
      <div className={`tabular text-xl font-semibold ${toneClass}`}>{value}</div>
      <div className="text-muted-foreground text-xs">{label}</div>
    </div>
  );
}

function RowTable({
  rows,
  categories,
  onDecision,
  onCategory,
  pending,
  showStatus,
}: {
  readonly rows: readonly FinanceImportRowView[];
  readonly categories: readonly FinanceCategory[];
  readonly onDecision: (rowId: string, decision: 'include' | 'exclude') => void;
  readonly onCategory: (rowId: string, categoryId: string | null) => void;
  readonly pending: boolean;
  readonly showStatus: boolean;
}): React.ReactElement {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8" />
          <TableHead>Date</TableHead>
          <TableHead>Merchant</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead>Category</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const failed = row.parseError !== null;
          const duplicate = row.duplicateOfTransactionId !== null;
          const rowName = row.normalizedMerchant ?? row.description ?? `row ${row.rowNumber}`;

          return (
            <TableRow key={row.id}>
              <TableCell>
                <input
                  type="checkbox"
                  aria-label={`Include ${rowName}`}
                  checked={row.decision === 'include'}
                  disabled={failed || pending}
                  onChange={(event) => onDecision(row.id, event.target.checked ? 'include' : 'exclude')}
                />
              </TableCell>
              <TableCell className="text-muted-foreground whitespace-nowrap">
                {row.transactionDate ?? '—'}
              </TableCell>
              <TableCell>
                {failed ? (
                  <span className="text-destructive text-sm">{row.parseError}</span>
                ) : (
                  <div>
                    <div className="font-medium">{row.normalizedMerchant}</div>
                    <div className="text-muted-foreground text-xs">{row.description}</div>
                  </div>
                )}
              </TableCell>
              <TableCell>{row.amountCents === null ? null : <Money valueCents={row.amountCents} />}</TableCell>
              <TableCell>
                {failed ? (
                  showStatus ? <StatusBadge tone="attention">Skipped</StatusBadge> : null
                ) : duplicate ? (
                  showStatus ? <StatusBadge tone="muted">Already imported</StatusBadge> : null
                ) : (
                  <Select
                    value={row.categoryId ?? 'none'}
                    onValueChange={(value) => onCategory(row.id, value === 'none' ? null : value)}
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
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function ImportDone({ result }: { readonly result: CommitResult }): React.ReactElement {
  return (
    <div className="space-y-3 rounded-md border p-4 text-sm">
      <p className="flex items-center gap-2 font-medium">Import complete</p>
      <ul className="text-muted-foreground list-disc space-y-1 pl-4">
        <li>
          {result.importedCount} transaction{result.importedCount === 1 ? '' : 's'} added
        </li>
        <li>{result.skippedDuplicateCount} skipped as already imported</li>
        {result.autoClassifiedCount > 0 ? (
          <li>{result.autoClassifiedCount} categorized or classified automatically — nothing to review</li>
        ) : null}
        {result.skippedFailedCount > 0 ? (
          <li>{result.skippedFailedCount} needed attention and were not imported</li>
        ) : null}
        {result.demotedByRaceCount > 0 ? (
          <li>
            {result.demotedByRaceCount} row{result.demotedByRaceCount === 1 ? '' : 's'} turned out to already be
            imported by another import committed at the same time, and{' '}
            {result.demotedByRaceCount === 1 ? 'was' : 'were'} skipped.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
