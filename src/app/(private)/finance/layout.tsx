import { SubNav } from '@/features/shell/nav';
import { requireOwner } from '@/server/auth/owner';
import { getNeedsReviewCount } from '@/server/db/finance/transactions';

/**
 * Sub-navigation within Finance, same pattern as `settings/layout.tsx`.
 * Without it, a page under here would exist but be unreachable from anywhere
 * in the UI other than typing the URL.
 *
 * Async (a Server Component, not a plain function) so the Review link can
 * carry a live needs-review count — one `count(*)`, nothing else. It calls
 * `requireOwner()` itself for the same reason every page under `(private)`
 * does: it needs the owner id to scope that query, and the parent layout's
 * guard does not hand it one.
 */
export default async function FinanceLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): Promise<React.ReactElement> {
  const owner = await requireOwner();
  const needsReviewCount = await getNeedsReviewCount(owner.userId);

  const links = [
    { href: '/finance/monthly', label: 'Monthly' },
    { href: '/finance/import', label: 'Import' },
    { href: '/finance/review', label: needsReviewCount > 0 ? `Review (${needsReviewCount})` : 'Review' },
  ] as const;

  return (
    <div className="space-y-8">
      <SubNav links={links} />
      {children}
    </div>
  );
}
