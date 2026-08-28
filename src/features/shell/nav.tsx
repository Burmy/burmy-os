'use client';

import { Gamepad2, Loader2, Settings, Table2 } from 'lucide-react';
import Link, { useLinkStatus } from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';

/**
 * The spinner that replaces a nav item's own icon while its navigation is in
 * flight.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS EVEN THOUGH EVERY ROUTE NOW HAS A `loading.tsx`
 *
 * A route-level fallback cannot render until the router has begun the
 * transition, which on a cold serverless function is not instant. In that gap
 * the old page is still fully on screen and nothing has acknowledged the
 * click — the single most common reading of which is that the click missed.
 * Real usage reported exactly that: "there is no indication as well."
 *
 * `useLinkStatus` closes the gap at its only possible source, inside the
 * `<Link>` itself. It must be a DESCENDANT of the Link (Next's own
 * requirement), which is why this is a component rather than a hook call in
 * the map below.
 *
 * It swaps the icon rather than adding a spinner beside it, deliberately:
 * appending anything shifts the label sideways mid-click, which is a layout
 * shift on the element the eye is already fixed on. Same box, different glyph.
 * ─────────────────────────────────────────────────────────────────────────────
 */
function NavIcon({ Icon }: { readonly Icon: typeof Gamepad2 }): React.ReactElement {
  const { pending } = useLinkStatus();
  return pending ? (
    <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
  ) : (
    <Icon className="size-4 shrink-0" aria-hidden />
  );
}

/** SubNav's equivalent — a tab has no icon, so the spinner follows the label instead of replacing anything. */
function TabPending(): React.ReactElement | null {
  const { pending } = useLinkStatus();
  return pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null;
}

/**
 * Three destinations: Finance, Games, Settings.
 *
 * Finance and Games are the two product modules; Settings is separated from
 * them by a rule below. There is no Home dashboard — each module's own landing
 * view IS its home. A fourth entry should require a real third module, not an
 * anticipated one.
 */
const LINKS = [
  { href: '/finance/monthly', label: 'Finance', Icon: Table2, match: '/finance' },
  { href: '/games/library', label: 'Games', Icon: Gamepad2, match: '/games' },
  { href: '/settings', label: 'Settings', Icon: Settings, match: '/settings' },
] as const;

/**
 * The main nav's link list — vertical, for the sidebar. Rendered twice: once
 * inside the fixed desktop `Sidebar`, once inside the mobile `MobileNav`
 * sheet. `onNavigate` lets the mobile sheet close itself on a link click.
 *
 * A rule appears before Settings — not before Finance or Games — because
 * Settings is configuration, set-and-forget, while Finance and Games are what
 * the app is for. Hardcoded at the one, permanent gap between the product
 * modules and Settings rather than a general "grouped links" prop: there is
 * exactly one such gap by design (see above), so a generic grouping API would
 * serve a case that doesn't exist.
 */
export function Nav({
  onNavigate,
  iconOnly,
}: {
  readonly onNavigate?: () => void;
  /** Collapsed desktop sidebar only — `MobileNav`'s drawer never passes this. */
  readonly iconOnly?: boolean;
}): React.ReactElement {
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
              {...(iconOnly ? { title: label } : {})}
              className={cn(
                'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                iconOnly ? 'justify-center px-2' : '',
                active
                  ? 'bg-secondary text-secondary-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60',
              )}
            >
              <NavIcon Icon={Icon} />
              {iconOnly ? null : label}
            </Link>
          </div>
        );
      })}
    </nav>
  );
}

/**
 * Sub-navigation within a section — Settings' Accounts/Categories, and
 * Finance's Monthly/Transactions/Review.
 *
 * Separate from the primary nav so the two do not have to share highlight logic;
 * `startsWith` on the primary would light up "Settings"/"Finance" for all of
 * these anyway.
 */
export function SubNav({
  links,
}: {
  readonly links: ReadonlyArray<{ href: string; label: string; badge?: number }>;
}): React.ReactElement {
  const pathname = usePathname();

  return (
    <nav aria-label="Section" className="flex gap-1 border-b">
      {links.map(({ href, label, badge }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors',
              active
                ? 'border-foreground text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground border-transparent',
            )}
          >
            {label}
            <TabPending />
            {badge ? (
              <span className="bg-secondary text-secondary-foreground tabular rounded-md px-1.5 py-0.5 text-xs">
                {badge}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
