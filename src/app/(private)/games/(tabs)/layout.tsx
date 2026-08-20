import { SubNav } from '@/features/shell/nav';
import { requireOwner } from '@/server/auth/owner';

/**
 * Library / Stats — the two Games screens that share a persistent tab bar.
 *
 * `requireOwner()` here is defense-in-depth alongside the page-level calls each
 * page makes itself. A layout guard alone would not protect a page's Server
 * Actions (see CLAUDE.md), so this does not replace those calls.
 */
export default async function GamesTabsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): Promise<React.ReactElement> {
  await requireOwner();

  const links = [
    { href: '/games/library', label: 'Library' },
    { href: '/games/stats', label: 'Stats' },
  ];

  return (
    <div className="space-y-6">
      <SubNav links={links} />
      {children}
    </div>
  );
}
