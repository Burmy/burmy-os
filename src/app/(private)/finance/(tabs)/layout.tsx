import { SubNav } from '@/features/shell/nav';
import { requireOwner } from '@/server/auth/owner';
import { getNeedsReviewCount } from '@/server/db/finance/transactions';

/**
 * Monthly / Transactions / Review — the three "browse your finances" screens
 * that deserve a persistent tab bar, unlike Import (a focused task page with
 * its own back-link, kept a sibling outside this route group on purpose).
 *
 * Fixes a real discoverability gap: before this, Review was reachable only
 * via a conditional banner on Monthly that disappeared entirely once nothing
 * needed review, and Transactions only via a toolbar button. Both are now
 * always-visible tabs, exactly like Settings' own Accounts/Categories SubNav.
 *
 * `requireOwner()` here is defense-in-depth alongside the page-level calls
 * each of these three pages already makes themselves — a layout guard alone
 * would not protect their Server Actions (see CLAUDE.md), so this does not
 * replace those calls, only adds the count needed for the badge below.
 */
export default async function FinanceTabsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): Promise<React.ReactElement> {
  const owner = await requireOwner();
  const needsReviewCount = await getNeedsReviewCount(owner.userId);

  const links = [
    { href: '/finance/monthly', label: 'Monthly' },
    { href: '/finance/transactions', label: 'Transactions' },
    // `exactOptionalPropertyTypes` is on — omit `badge` entirely when zero
    // rather than setting it to `undefined`. See CLAUDE.md.
    { href: '/finance/review', label: 'Review', ...(needsReviewCount > 0 ? { badge: needsReviewCount } : {}) },
  ];

  return (
    <div className="space-y-6">
      <SubNav links={links} />
      {children}
    </div>
  );
}
