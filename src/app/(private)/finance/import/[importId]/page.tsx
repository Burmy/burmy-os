import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PageHeader } from '@/components/ui/page-header';
import { PageMeta } from '@/components/ui/page-meta';
import { ImportReviewTable } from '@/features/finance/import/review-table';
import { requireOwner } from '@/server/auth/owner';
import { listAccounts } from '@/server/db/finance/accounts';
import { listCategories } from '@/server/db/finance/categories';
import { NotFoundError } from '@/server/db/finance/errors';
import {
  findPriorFileUpload,
  getImportForOwner,
  getImportRows,
} from '@/server/db/finance/imports';

export const metadata: Metadata = { title: 'Review import — Burmy' };

export default async function ImportReviewPage({
  params,
}: {
  readonly params: Promise<{ importId: string }>;
}): Promise<React.ReactElement> {
  const { importId } = await params;
  const owner = await requireOwner();

  let importRecord;
  try {
    importRecord = await getImportForOwner(owner.userId, importId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const [rows, categories, accounts, priorUpload] = await Promise.all([
    getImportRows(owner.userId, importId),
    listCategories(owner.userId),
    listAccounts(owner.userId),
    // Excludes THIS import — otherwise every import would report itself as its
    // own prior upload. Only a status of 'committed' means the file was
    // actually imported before; 'review' or 'discarded' get a different
    // sentence entirely. See ImportReviewTable.
    findPriorFileUpload(owner.userId, importRecord.fileSha256, importId),
  ]);

  const account = accounts.find((candidate) => candidate.id === importRecord.accountId);

  return (
    <div>
      <Link href="/finance/monthly" className="text-muted-foreground hover:text-foreground text-sm">
        ← Finance
      </Link>
      <PageHeader title="Review import" className="mt-2" />

      {/* Which file this is, is real identifying context rather than prose —
          it moves to `PageMeta` with every other live line in the app. */}
      <PageMeta className="mt-4">
        <span>{importRecord.originalFilename}</span>
        <span>{account?.name ?? 'Unknown account'}</span>
      </PageMeta>

      <ImportReviewTable
        importId={importId}
        status={importRecord.status}
        rows={rows}
        categories={categories}
        priorUpload={priorUpload}
      />
    </div>
  );
}
