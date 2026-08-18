'use client';

import { Settings, Table2 } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';

/**
 * Two destinations. That is the whole application.
 *
 * Finance and Settings — no Home dashboard (the monthly grid IS the landing
 * experience), and no nav entries for modules that do not exist. Adding a third
 * entry should require a real second module, not an anticipated one.
 *
 * `/settings` (not `/settings/finance/accounts`) — Settings has its own real
 * landing page now, so the primary nav points at the section, not one page
 * inside it.
 */
const LINKS = [
  { href: '/finance/monthly', label: 'Finance', Icon: Table2, match: '/finance' },
  { href: '/settings', label: 'Settings', Icon: Settings, match: '/settings' },
] as const;

/**
 * The main nav's link list — vertical, for the sidebar. Rendered twice: once
 * inside the fixed desktop `Sidebar`, once inside the mobile `MobileNav`
 * sheet. `onNavigate` lets the mobile sheet close itself on a link click.
 *
 * A rule appears before Settings — not before Finance — because Settings is
 * configuration, set-and-forget, while Finance is the thing the app is for.
 * Hardcoded at the one, permanent gap between the two rather than a general
 * "grouped links" prop: there are exactly two destinations by design (see
 * above), so a generic grouping API would serve a case that doesn't exist.
 */
export function Nav({ onNavigate }: { readonly onNavigate?: () => void }): React.ReactElement {
  const pathname = usePathname();

  return (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {LINKS.map(({ href, label, Icon, match }) => {
        const active = pathname.startsWith(match);
        return (
          // `contents` rather than React.Fragment: it needs no import and
          // still lets an optional sibling (the rule) sit next to the Link
          // under one `key`, with zero effect on the flex layout around it.
          <div key={href} className="contents">
            {label === 'Settings' ? <hr className="border-border my-2" /> : null}
            <Link
              href={href}
              aria-current={active ? 'page' : undefined}
              {...(onNavigate ? { onClick: onNavigate } : {})}
              className={cn(
                'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                active
                  ? 'bg-secondary text-secondary-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60',
              )}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          </div>
        );
      })}
    </nav>
  );
}

/**
 * Sub-navigation within Settings.
 *
 * Separate from the primary nav so the two do not have to share highlight logic;
 * `startsWith` on the primary would light up "Settings" for all of these anyway.
 */
export function SubNav({
  links,
}: {
  readonly links: ReadonlyArray<{ href: string; label: string }>;
}): React.ReactElement {
  const pathname = usePathname();

  return (
    <nav aria-label="Section" className="flex gap-1 border-b">
      {links.map(({ href, label }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
              active
                ? 'border-foreground text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground border-transparent',
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
