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
 */
const LINKS = [
  { href: '/finance/monthly', label: 'Finance', Icon: Table2, match: '/finance' },
  { href: '/settings/accounts', label: 'Settings', Icon: Settings, match: '/settings' },
] as const;

export function Nav(): React.ReactElement {
  const pathname = usePathname();

  return (
    <nav aria-label="Main" className="flex items-center gap-1">
      {LINKS.map(({ href, label, Icon, match }) => {
        const active = pathname.startsWith(match);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors',
              active
                ? 'bg-secondary text-secondary-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60',
            )}
          >
            <Icon className="size-4" />
            {label}
          </Link>
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
