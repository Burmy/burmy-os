import { formatHours, hours } from '@/server/games/hours';

/** Cycles the 16-color palette defined in `globals.css`. Shared tokens, module-local helper. */
const CHART_COLORS = [
  'var(--color-chart-cat-1)', 'var(--color-chart-cat-2)', 'var(--color-chart-cat-3)',
  'var(--color-chart-cat-4)', 'var(--color-chart-cat-5)', 'var(--color-chart-cat-6)',
  'var(--color-chart-cat-7)', 'var(--color-chart-cat-8)', 'var(--color-chart-cat-9)',
  'var(--color-chart-cat-10)', 'var(--color-chart-cat-11)', 'var(--color-chart-cat-12)',
  'var(--color-chart-cat-13)', 'var(--color-chart-cat-14)', 'var(--color-chart-cat-15)',
  'var(--color-chart-cat-16)',
] as const;

export function categoryColor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length]!;
}

/** Axis + tooltip label for a tenths-of-an-hour value. */
export function formatAxisHours(tenths: number): string {
  return formatHours(hours(Math.round(tenths)));
}

/**
 * A domain that always includes zero and never degenerates to a single value.
 * Recharts prints the same tick label five times when `dataMin === dataMax`.
 */
export function computeChartDomain(values: readonly number[]): [number, number] {
  if (values.length === 0) return [0, 10];

  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  if (max === min) return [min, min + 10];
  return [min, max];
}

/** The shared tooltip styling every Games chart uses. */
export const TOOLTIP_STYLES = {
  contentStyle: {
    background: 'var(--color-popover)',
    color: 'var(--color-popover-foreground)',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-md)',
    fontSize: 13,
  },
  // Recharts colors each item's text with the series fill, which is not
  // guaranteed readable against the popover background — force the theme
  // foreground. Same fix carried across every chart in this app.
  itemStyle: { color: 'var(--color-popover-foreground)' },
  labelStyle: { color: 'var(--color-popover-foreground)' },
} as const;
