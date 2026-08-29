import { SubNav } from '@/features/shell/nav';
import { requireOwner } from '@/server/auth/owner';

/**
 * Library / Log / Stats — the Anime screens that share a persistent tab bar.
 *
 * `requireOwner()` here is defense-in-depth alongside each page's own call. A
 * layout guard would not protect a page's Server Actions (see CLAUDE.md), so
 * this does not replace them.
 */
export default async function AnimeTabsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): Promise<React.ReactElement> {
  await requireOwner();

  const links = [
    { href: '/anime/library', label: 'Library' },
    { href: '/anime/log', label: 'Log' },
    { href: '/anime/stats', label: 'Stats' },
  ];

  return (
    <div className="space-y-6">
      <SubNav links={links} />
      {children}
    </div>
  );
}
