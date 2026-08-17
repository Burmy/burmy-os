'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import type { FinanceAccount } from '@/server/db/finance/accounts';
import type { FinanceImportSummary } from '@/server/db/finance/imports';
import { uploadStatementAction } from './actions';

/**
 * Upload form plus the in-progress list.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The account picker is REQUIRED, not a convenience default. Burmy never
 * connects to a bank, so the account a statement belongs to is exclusively the
 * owner's own labelling — nothing in the file says which of several checking
 * accounts it is. `uploadStatementAction` separately checks the DETECTED
 * format against whichever account is chosen here (a card export cannot be
 * staged against a checking account), so picking the wrong one produces a
 * clear error rather than silently misfiled spending.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function ImportUploadForm({
  accounts,
  inProgressImports,
}: {
  readonly accounts: readonly FinanceAccount[];
  readonly inProgressImports: readonly FinanceImportSummary[];
}): React.ReactElement {
  const router = useRouter();
  const [accountId, setAccountId] = useState<string>(accounts[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(formData: FormData): void {
    setError(null);
    // The Select is a Radix component and does not post a native form value.
    formData.set('accountId', accountId);

    startTransition(async () => {
      const result = await uploadStatementAction(formData);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/finance/import/${result.importId}`);
    });
  }

  return (
    <div className="mt-8 space-y-10">
      {accounts.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Add an account under Settings → Accounts before importing a statement.
        </p>
      ) : (
        <form action={submit} className="max-w-md space-y-4">
          <div className="space-y-2">
            <Label htmlFor="account-trigger">Account</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger id="account-trigger">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="file">Statement (.csv)</Label>
            <Input id="file" name="file" type="file" accept=".csv" required />
          </div>

          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}

          <Button type="submit" disabled={pending || !accountId}>
            {pending ? 'Uploading…' : 'Upload'}
          </Button>
        </form>
      )}

      {inProgressImports.length > 0 ? (
        <div>
          <h2 className="text-sm font-semibold">Awaiting review</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Staged, not yet imported. Nothing here has touched your transaction history.
          </p>
          <Table className="mt-3">
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Rows</TableHead>
                <TableHead>Uploaded</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {inProgressImports.map((imp) => {
                const account = accounts.find((candidate) => candidate.id === imp.accountId);
                return (
                  <TableRow key={imp.id}>
                    <TableCell className="font-medium">{imp.originalFilename}</TableCell>
                    <TableCell>{account?.name ?? '—'}</TableCell>
                    <TableCell>{imp.rowCount}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(imp.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={`/finance/import/${imp.id}`}>Resume</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </div>
  );
}
