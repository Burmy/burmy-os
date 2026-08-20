import { cookies } from 'next/headers';

/**
 * Which Monthly year-grid category columns the owner has hidden — a display
 * preference, not data. The grid itself always computes every column's totals
 * server-side regardless of this cookie (CLAUDE.md: the grid is a view, never
 * stored); hiding a column only removes it from render.
 *
 * Same no-flash cookie pattern as theme.ts/sidebar.ts: read during SSR so the
 * grid never paints a column only to remove it a moment later. Stored as a
 * comma-separated list of category ids — safe to split on, since ids are
 * UUIDs and never contain a comma.
 */
export const HIDDEN_GRID_COLUMNS_COOKIE = 'burmy.hidden-grid-columns';

export async function readHiddenGridColumns(): Promise<readonly string[]> {
  const store = await cookies();
  const value = store.get(HIDDEN_GRID_COLUMNS_COOKIE)?.value;
  return value ? value.split(',').filter((id) => id.length > 0) : [];
}
