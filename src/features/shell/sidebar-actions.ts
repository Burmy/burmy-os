'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';

import { requireOwner } from '@/server/auth/owner';
import { SIDEBAR_COLLAPSED_COOKIE } from '@/server/security/sidebar';

/**
 * Persist the sidebar's collapsed/expanded state — same cookie + Server
 * Action round trip `theme-actions.ts`'s `setTheme()` already establishes,
 * for the same reason: the width is decided server-side during SSR, so
 * there's nothing to flip client-side after the fact.
 *
 * `requireOwner()` first, like every other Server Action — see that file's
 * own comment for why this has no exceptions, even for something this
 * low-stakes.
 */
export async function setSidebarCollapsed(collapsed: boolean): Promise<void> {
  await requireOwner();

  const store = await cookies();
  if (collapsed) {
    store.set(SIDEBAR_COLLAPSED_COOKIE, '1', {
      path: '/',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 365,
      secure: process.env.NODE_ENV === 'production',
    });
  } else {
    store.delete(SIDEBAR_COLLAPSED_COOKIE);
  }

  revalidatePath('/', 'layout');
}
