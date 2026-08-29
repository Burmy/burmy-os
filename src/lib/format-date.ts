/**
 * Month names, defined HERE rather than imported from `@/server/finance/grid`,
 * where they used to live.
 *
 * `src/lib/` is the app's shared, framework-free layer — reaching from it into
 * a product module inverted the dependency and put a Finance import in the
 * Games and Anime bundles behind every use of `formatHumanDate` below.
 * `src/server/games/release-date.ts` documents that exact constraint as its
 * reason for not reusing this file. Finance re-exports the constant from here,
 * so its own call sites are unchanged.
 */
export const MONTH_ABBREVIATIONS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;
/**
 * "2026-05-02" -> "May 2, 2026". Parses the ISO string's parts directly
 * rather than going through `new Date(iso)` — that constructor treats a
 * bare date as UTC midnight, and formatting it back out in whatever
 * timezone the browser runs in can shift the displayed day by one. Every
 * date this app stores is already a plain calendar date with no time
 * component, so there is nothing a timezone-aware `Date` object would add
 * except a chance to get it wrong.
 */
export function formatHumanDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  const monthIndex = Number(month) - 1;
  const monthName = MONTH_ABBREVIATIONS[monthIndex];
  if (!monthName || !day || !year) return isoDate;
  return `${monthName} ${Number(day)}, ${year}`;
}
