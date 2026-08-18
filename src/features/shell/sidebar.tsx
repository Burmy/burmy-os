import { Nav } from './nav';

/**
 * Fixed-width desktop sidebar. Deliberately NOT the full shadcn `Sidebar`
 * pattern (`SidebarProvider`, cookie-persisted collapse state, icon-rail
 * mode, keyboard shortcut, tooltips) — with exactly two destinations
 * (Finance, Settings) that machinery has nothing to earn its keep against.
 * This is plain navigation chrome: a static column, hidden below `md` where
 * `MobileNav`'s Sheet takes over.
 *
 * `footer` is a slot for the theme toggle — kept as a prop rather than
 * imported here so this file stays server-renderable; `ThemeToggle` is a
 * client component that needs the current theme as a prop from its own
 * Server Component ancestor.
 */
export function Sidebar({ footer }: { readonly footer?: React.ReactNode }): React.ReactElement {
  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r md:flex">
      <div className="px-4 py-4">
        <span className="text-xs font-semibold tracking-widest uppercase">Burmy</span>
      </div>
      <div className="flex-1 px-3">
        <Nav />
      </div>
      {footer ? <div className="border-t p-3">{footer}</div> : null}
    </aside>
  );
}
