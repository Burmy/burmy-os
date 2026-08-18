import type { Metadata } from 'next';

import { CategoriesManager } from '@/features/finance/settings/categories-manager';
import { requireOwner } from '@/server/auth/owner';
import { listCategories } from '@/server/db/finance/categories';

export const metadata: Metadata = { title: 'Categories — Burmy' };

export default async function CategoriesPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();

  // One read, split here. Archived rows are needed for the restore list but must
  // never reach a picker, which is why `listCategories` excludes them by default.
  const all = await listCategories(owner.userId, { includeArchived: true });

  return (
    <CategoriesManager
      live={all.filter((category) => category.archivedAt === null)}
      archived={all.filter((category) => category.archivedAt !== null)}
    />
  );
}
