'use client';

import { useState } from 'react';

import { cn } from '@/lib/utils';
import { Nav } from './nav';
import { setSidebarCollapsed } from './sidebar-actions';
import { SidebarToggle } from './sidebar-toggle';

/**
 * Fixed-width desktop sidebar, now with one addition: a collapsed/icon-rail
 * mode. Still deliberately NOT the full shadcn `Sidebar` pattern
 * (`SidebarProvider`, keyboard shortcut, tooltips) — with exactly two
 * top-level destinations (Finance, Settings) that machinery has nothing to
 * earn its keep against. This stays plain navigation chrome: a static
 * column whose width toggles between two fixed values, hidden below `md`
 * where `MobileNav`'s Sheet takes over (which never collapses — a drawer is
 * already as narrow as it needs to be).
 *
 * Collapsed state is CLIENT-local, not server-round-tripped: `initialCollapsed`
 * seeds it from the cookie the layout already read at SSR time, but the click
 * itself flips local state immediately (with a CSS transition on the width) and
 * persists to the cookie afterward as a best-effort background write. Toggling
 * previously blocked on a Server Action doing `revalidatePath('/', 'layout')` —
 * a full-app Router Cache invalidation for a purely visual change — which is
 * why the collapse used to feel like it was waiting on the network. It never
 * needed to: the cookie only matters for the NEXT fresh page load, which
 * already reads it correctly via the normal SSR path with no revalidation.
 *
 * `footer` is a slot for the theme toggle — kept as a prop rather than
 * imported here so the SERVER PARENT stays the one resolving the current
 * theme; `ThemeToggle` is a client component that needs it as a prop from its
 * own Server Component ancestor.
 */
export function Sidebar({
  footer,
  initialCollapsed,
}: {
  readonly footer?: React.ReactNode;
  readonly initialCollapsed: boolean;
}): React.ReactElement {
  const [collapsed, setCollapsed] = useState(initialCollapsed);

  function toggle(): void {
    const next = !collapsed;
    setCollapsed(next);
    // Best-effort persistence — the visual state above is already correct
    // regardless of whether this succeeds, so a network hiccup here just
    // means the next fresh page load falls back to the previous cookie value.
    setSidebarCollapsed(next).catch(() => {});
  }

  return (
    <aside
      className={cn(
        'hidden shrink-0 flex-col border-r transition-[width] duration-200 ease-in-out md:flex',
        collapsed ? 'w-14' : 'w-56',
      )}
    >
      <div className={cn('flex items-center py-4', collapsed ? 'justify-center px-2' : 'justify-between px-4')}>
        {collapsed ? null : <span className="text-xs font-semibold tracking-widest uppercase">Burmy</span>}
        <SidebarToggle collapsed={collapsed} onToggle={toggle} />
      </div>
      <div className={cn('flex-1', collapsed ? 'px-2' : 'px-3')}>
        <Nav iconOnly={collapsed} />
      </div>
      {footer ? <div className={cn('border-t p-3', collapsed ? 'flex justify-center' : '')}>{footer}</div> : null}
    </aside>
  );
}
