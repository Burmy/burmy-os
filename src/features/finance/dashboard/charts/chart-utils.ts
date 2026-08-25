import { cents, format } from '@/server/finance/money';

/**
 * `categoryColor` and the shared tooltip styling both live in
 * `@/components/ui/chart-utils` now — this module keeps only what stays
 * Finance-specific: dollar-formatted axis/tooltip labels and its own
 * `computeChartDomain` (see that shared module's doc comment for why the
 * domain function was NOT unified with Games').
 */

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
