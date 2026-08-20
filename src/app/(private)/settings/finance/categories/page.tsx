import type { Metadata } from 'next';
import Link from 'next/link';

import { CategoriesManager } from '@/features/finance/settings/categories-manager';
import { requireOwner } from '@/server/auth/owner';
import { getCategoryTransactionCounts, listCategories } from '@/server/db/finance/categories';

export const metadata: Metadata = { title: 'Categories — Burmy' };

/**
 * Calls `requireOwner()` directly, not because the layout forgot to, but because
 * the owner id is what scopes the read. There is no way to call `listCategories`
 * without one.
 */
export default async function CategoriesPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();

  // One read, split here. Archived rows are needed for the restore list but must
  // never reach a picker, which is why `listCategories` excludes them by default.
  const [all, transactionCountsByCategory] = await Promise.all([
    listCategories(owner.userId, { includeArchived: true }),
    getCategoryTransactionCounts(owner.userId),
  ]);

  return (
    <div>
      <Link href="/settings" className="text-muted-foreground hover:text-foreground text-sm">
        ← Settings
      </Link>
      <div className="mt-2">
        <CategoriesManager
          live={all.filter((category) => category.archivedAt === null)}
          archived={all.filter((category) => category.archivedAt !== null)}
          transactionCounts={Object.fromEntries(transactionCountsByCategory)}
        />
      </div>
    </div>
  );
}
