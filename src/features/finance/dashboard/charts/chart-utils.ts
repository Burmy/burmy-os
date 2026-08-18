import { cents, format } from '@/server/finance/money';

/** Category series colors — cycles through the 6-color muted palette in `globals.css`, same tokens the breakdown bar chart and the trend lines both read, so a category keeps the same color in both charts. */
export const CATEGORY_CHART_COLORS = [
  'var(--color-chart-cat-1)',
  'var(--color-chart-cat-2)',
  'var(--color-chart-cat-3)',
  'var(--color-chart-cat-4)',
  'var(--color-chart-cat-5)',
  'var(--color-chart-cat-6)',
] as const;

export function categoryColor(index: number): string {
  return CATEGORY_CHART_COLORS[index % CATEGORY_CHART_COLORS.length]!;
}

/** Compact axis tick, e.g. `$1.2k` — full precision belongs in the tooltip, not the axis. */
export function formatAxisDollars(amountCents: number): string {
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  return formatter.format(amountCents / 100);
}

/** Full-precision tooltip value, reusing the app's one money formatter. */
export function formatTooltipDollars(amountCents: number): string {
  return format(cents(Math.round(amountCents)));
}
