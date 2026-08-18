'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';

import { requireOwner } from '@/server/auth/owner';
import { THEME_COOKIE, type Theme, isTheme, themeCookieOptions } from '@/server/security/theme';

/**
 * Set the theme preference.
 *
 * Starts with `requireOwner()` like every other Server Action, even though a
 * theme is not sensitive. The rule from docs/SECURITY.md is that EVERY protected
 * server entry point authenticates itself — the value of that rule is that it has
 * no exceptions to reason about, and
 * `tests/integration/entry-points.test.ts` enforces it by enumerating the
 * filesystem.
 */
export async function setTheme(theme: Theme): Promise<void> {
  await requireOwner();

  // Validate even though the parameter is typed: a Server Action is an HTTP
  // endpoint, and the type annotation is erased at runtime. Anything can POST
  // here.
  if (!isTheme(theme)) return;

  const store = await cookies();
  store.set(THEME_COOKIE, theme, themeCookieOptions());

  // The theme class is rendered server-side, so the layout has to re-render for
  // the change to appear.
  revalidatePath('/', 'layout');
}
