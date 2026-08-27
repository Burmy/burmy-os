/**
 * Chart color palette and tooltip styling shared by every Recharts chart in
 * both Finance and Games. `computeChartDomain` is deliberately NOT here:
 * Finance pads a degenerate domain by `max(20% of |min|, 1000)` (cents) and
 * folds `[0, ...values]` before checking degeneracy, while Games pads by a
 * flat `10` (tenths of an hour), extends upward only, and short-circuits an
 * empty series to `[0, 10]` — two genuinely different shapes, not just two
 * magnitudes of the same pad. Each module keeps its own `computeChartDomain`
 * in its local `chart-utils.ts` so neither's chart scaling changes.
 */

/** Cycles the 16-color muted palette defined in `globals.css`. */
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

/**
 * The shared tooltip styling every chart in both modules uses.
 *
 * `cursor: false` — Recharts' default bar-chart tooltip cursor is an opaque
 * `#ccc` rectangle spanning the full plot height. Without this it rendered
 * as a large grey block behind the Ratings chart's bars (and would behind
 * any other bar chart that spreads this object without its own `cursor`
 * override, such as `yearly-breakdown-chart`'s custom tooltip, which sets
 * its own lighter cursor deliberately and does not use this constant).
 */
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
  cursor: false,
} as const;
