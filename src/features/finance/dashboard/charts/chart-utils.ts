import { cents, format } from '@/server/finance/money';

/** Category series colors — cycles through the 16-color muted palette in `globals.css`, same tokens the breakdown bar chart and the trend lines both read, so a category keeps the same color in both charts. Past 16 simultaneous categories, colors repeat — an acceptable limit, since that many concurrent hues stop being visually distinguishable to a human regardless of how they're chosen. */
const CATEGORY_CHART_COLORS = [
  'var(--color-chart-cat-1)',
  'var(--color-chart-cat-2)',
  'var(--color-chart-cat-3)',
  'var(--color-chart-cat-4)',
  'var(--color-chart-cat-5)',
  'var(--color-chart-cat-6)',
  'var(--color-chart-cat-7)',
  'var(--color-chart-cat-8)',
  'var(--color-chart-cat-9)',
  'var(--color-chart-cat-10)',
  'var(--color-chart-cat-11)',
  'var(--color-chart-cat-12)',
  'var(--color-chart-cat-13)',
  'var(--color-chart-cat-14)',
  'var(--color-chart-cat-15)',
  'var(--color-chart-cat-16)',
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

/**
 * A Y-axis domain that always includes the zero baseline and never
 * degenerates to a single repeated value.
 *
 * Left to its own defaults, Recharts computes a domain from `[dataMin,
 * dataMax]` of whatever is plotted — with exactly one data point (or every
 * point identical, e.g. a net-cash-flow chart with only one populated
 * month), `dataMin === dataMax` and its tick generator then prints the SAME
 * label 5 times (`-$43`, `-$43`, `-$43`, `-$43`) instead of a real scale.
 * Always folding `0` into the min/max fixes the common case (a single
 * non-zero value now spans `[value, 0]` or `[0, value]`); the explicit pad
 * below only fires for the genuinely degenerate remainder — all-zero data,
 * or (in principle) a single data point that happens to be exactly `0`.
 */
export function computeChartDomain(values: readonly number[]): [number, number] {
  const withZero = [0, ...values];
  let min = Math.min(...withZero);
  let max = Math.max(...withZero);
  if (min === max) {
    const pad = Math.max(Math.abs(min) * 0.2, 1000);
    min -= pad;
    max += pad;
  }
  return [min, max];
}
