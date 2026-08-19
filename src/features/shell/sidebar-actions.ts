'use server';

import { cookies } from 'next/headers';

import { requireOwner } from '@/server/auth/owner';
import { SIDEBAR_COLLAPSED_COOKIE } from '@/server/security/sidebar';

/**
 * Persist the sidebar's collapsed/expanded state for the NEXT fresh page
 * load. The current session's visual state is already client-local (see
 * `Sidebar`) — this is a best-effort background write, not something the UI
 * waits on, so it deliberately does not `revalidatePath()`: that would
 * invalidate the entire app's Router Cache for a change nothing currently
 * on screen needs re-rendered to reflect.
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
}
