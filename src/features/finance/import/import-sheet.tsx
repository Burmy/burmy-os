'use client';

import { FileUp } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';

import { EmptyState } from '@/components/finance/empty-state';
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
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { toast } from '@/components/ui/toast';
import type { FinanceAccount } from '@/server/db/finance/accounts';
import type { FinanceImportSummary } from '@/server/db/finance/imports';
import { quickStartBoaAccountsAction } from '../settings/account-actions';
import { detectStatementFormatAction, uploadStatementAction } from './actions';

const LAST_ACCOUNT_STORAGE_KEY = 'burmy:lastImportAccountId';

/**
 * Upload only — a short-lived step, not a review UI. Staging a file
 * immediately navigates to `/finance/import/[importId]` (the full-page
 * review, `review-table.tsx`), which is the one canonical place to preview,
 * edit, and commit an import. This Sheet used to render that review inline
 * in its own scrollable pane — a Table nested inside an `overflow-y-auto`
 * div, itself inside a fixed-height side panel — which is exactly the
 * nested-scroll problem the full-page route was built to avoid. Keeping
 * upload and review as two separate surfaces removes that nesting
 * structurally instead of trying to patch the Sheet's internal layout.
 */
export function ImportSheet({
  accounts,
  inProgressImports,
}: {
  readonly accounts: readonly FinanceAccount[];
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

  const activeAccounts = accounts.filter((account) => account.isActive);

  function resetForOpen(): void {
    setError(null);
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

  /** Stage the file against a known account, then hand off to the review page. */
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
      setOpen(false);
      router.push(`/finance/import/${outcome.importId}`);
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

  function quickStart(): void {
    startTransition(async () => {
      const outcome = await quickStartBoaAccountsAction();
      if (!outcome.ok) toast.error(outcome.error);
      else router.refresh();
    });
  }

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
            onQuickStart={quickStart}
          />
        </div>
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
  onQuickStart,
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
  readonly onQuickStart: () => void;
}): React.ReactElement {
  if (activeAccounts.length === 0) {
    return (
      <EmptyState>
        <div className="space-y-3">
          <p>Add an account before importing a statement.</p>
          <Button size="sm" variant="outline" disabled={pending} onClick={onQuickStart}>
            Set up Bank of America (Checking + Credit Card)
          </Button>
        </div>
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
