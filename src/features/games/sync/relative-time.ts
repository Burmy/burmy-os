/**
 * A short, coarse relative-time phrase — "3 days ago", "just now" — for the
 * small "Synced …" line under a Games sync button.
 *
 * Deliberately GAMES-LOCAL rather than reusing `src/lib/format-date.ts`:
 * that module imports `MONTH_ABBREVIATIONS` from `@/server/finance/grid`,
 * and CLAUDE.md forbids Finance and Games code from importing each other —
 * pulling it in here would put a Finance import in the Games bundle. This
 * is a small, independent formatter, not a shared "date utils" module worth
 * factoring out — exactly the kind of thing CLAUDE.md asks each product
 * module to own rather than share.
 *
 * Deliberately coarse: the single largest whole unit only, never "3 days, 4
 * hours ago" — this text sits under a button as quiet, secondary chrome,
 * not a precise audit-log timestamp.
 */
export function formatRelativeTime(date: Date, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));

  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;

  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}
