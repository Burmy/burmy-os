import { cn } from '@/lib/utils';
import { Nav } from './nav';
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
 * `footer` is a slot for the theme toggle — kept as a prop rather than
 * imported here so this file stays server-renderable; `ThemeToggle` is a
 * client component that needs the current theme as a prop from its own
 * Server Component ancestor. `collapsed` is decided the same way, by the
 * layout, from a cookie — see `server/security/sidebar.ts`.
 */
export function Sidebar({
  footer,
  collapsed,
}: {
  readonly footer?: React.ReactNode;
  readonly collapsed: boolean;
}): React.ReactElement {
  return (
    <aside className={cn('hidden shrink-0 flex-col border-r md:flex', collapsed ? 'w-14' : 'w-56')}>
      <div className={cn('flex items-center py-4', collapsed ? 'justify-center px-2' : 'justify-between px-4')}>
        {collapsed ? null : <span className="text-xs font-semibold tracking-widest uppercase">Burmy</span>}
        <SidebarToggle collapsed={collapsed} />
      </div>
      <div className={cn('flex-1', collapsed ? 'px-2' : 'px-3')}>
        <Nav iconOnly={collapsed} />
      </div>
      {footer ? <div className={cn('border-t p-3', collapsed ? 'flex justify-center' : '')}>{footer}</div> : null}
    </aside>
  );
}
