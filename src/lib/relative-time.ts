/**
 * A short, coarse relative-time phrase — "3 days ago", "just now" — for the
 * small "Synced …" line under a sync button.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS LIVED IN `src/features/games/sync/` UNTIL ANIME NEEDED IT TOO.
 *
 * Its original comment argued for keeping it Games-local, and that argument
 * was right for one consumer. With a second product module needing the exact
 * same phrase the only alternatives were a cross-feature import (which
 * CLAUDE.md forbids outright) or a byte-identical copy — and unlike a Games
 * card and an Anime card, whose constraints genuinely differ, this is a pure
 * function of a `Date` with no module-specific constraint at all. Promoting a
 * proven, framework-free helper into `src/lib/` is not the shared module
 * framework the rule forbids; importing across feature modules would be.
 *
 * It stays its OWN file rather than joining `src/lib/format-date.ts`, which
 * imports `MONTH_ABBREVIATIONS` from `@/server/finance/grid` — merging into
 * it would put a Finance import in the Games and Anime bundles, which is the
 * constraint the original comment identified and it still holds.
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
