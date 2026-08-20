'use server';

import { cookies } from 'next/headers';

import { requireOwner } from '@/server/auth/owner';
import { HIDDEN_GRID_COLUMNS_COOKIE } from '@/server/security/grid-columns';

/**
 * Persist which grid columns are hidden, for the NEXT fresh page load. The
 * current session's visual state is already client-local (see
 * `MonthlyGridTable`) — this is the same best-effort background write as
 * `setSidebarCollapsed`, and deliberately does not `revalidatePath()` for the
 * same reason: nothing currently on screen needs re-rendering to reflect it.
 */
export async function setHiddenGridColumns(hiddenIds: readonly string[]): Promise<void> {
  await requireOwner();

  const store = await cookies();
  if (hiddenIds.length === 0) {
    store.delete(HIDDEN_GRID_COLUMNS_COOKIE);
    return;
  }

  store.set(HIDDEN_GRID_COLUMNS_COOKIE, hiddenIds.join(','), {
    path: '/',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
    secure: process.env.NODE_ENV === 'production',
  });
}
