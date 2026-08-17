import type { Metadata } from 'next';

import { ImportUploadForm } from '@/features/finance/import/upload-form';
import { requireOwner } from '@/server/auth/owner';
import { listAccounts } from '@/server/db/finance/accounts';
import { listInProgressImports } from '@/server/db/finance/imports';

export const metadata: Metadata = { title: 'Import — Burmy' };

/**
 * Upload entry point, plus anything still sitting in `review` — the owner may
 * have navigated away mid-review, and this is the only way back to it in M5
 * (there is no browsing of past, already-committed imports yet; that waits
 * for a real transactions view in M9).
 */
export default async function ImportPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();
  const [accounts, inProgress] = await Promise.all([
    listAccounts(owner.userId),
    listInProgressImports(owner.userId),
  ]);

  return (
    <div>
      <h1 className="text-xl font-semibold">Import a statement</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Select or drag a CSV from Bank of America. It is parsed in memory and never
        written to disk — only the normalized preview below is saved.
      </p>

      <ImportUploadForm
        accounts={accounts.filter((account) => account.isActive)}
        inProgressImports={inProgress}
      />
    </div>
  );
}
