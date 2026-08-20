import { MONTH_ABBREVIATIONS } from '@/server/finance/grid';

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
