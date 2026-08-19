import { cookies } from 'next/headers';

/**
 * Sidebar collapsed/expanded — a cookie, read server-side, same no-flash
 * reasoning as `theme.ts`'s `THEME_COOKIE`: the class/width is decided during
 * SSR, so there is nothing for the client to flip after paint. Presence-only,
 * not a 3-state enum like theme, because there are only two states here.
 */
export const SIDEBAR_COLLAPSED_COOKIE = 'burmy.sidebar-collapsed';

export async function readSidebarCollapsed(): Promise<boolean> {
  const store = await cookies();
  return store.get(SIDEBAR_COLLAPSED_COOKIE)?.value === '1';
}
