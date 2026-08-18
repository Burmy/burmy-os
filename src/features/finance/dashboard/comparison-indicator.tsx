import { formatPercent } from '@/components/finance/format-percent';
import type { ComparisonDirection, MetricComparison } from '@/server/finance/dashboard';
import { cents, format } from '@/server/finance/money';

const DIRECTION_CLASS: Record<ComparisonDirection, string> = {
  favorable: 'text-[var(--chart-income)]',
  unfavorable: 'text-destructive',
  neutral: 'text-muted-foreground',
};

/**
 * "↓ $420 vs July" / "+8.4% vs last month" — subtle, not a badge. The ARROW
 * reflects the actual sign of the change (down when the number went down,
 * up when it went up) — it is NOT keyed by favorability. Only the COLOR
 * encodes whether that direction is good news: a lower EXPENSE is favorable
 * (green ↓), a lower INCOME is unfavorable (red ↓) — same arrow, opposite
 * color, because `direction` (favorable/unfavorable/neutral) is decided by
 * the caller (`compareToPreviousMonth`) per-metric, never inferred here.
 */
export function ComparisonIndicator({
  comparison,
  previousLabel,
}: {
  readonly comparison: MetricComparison | null;
  readonly previousLabel: string;
}): React.ReactElement | null {
  if (!comparison) return null;

  const magnitude = format(cents(Math.abs(comparison.deltaCents)));
  const percent = comparison.deltaPercent === null ? null : formatPercent(Math.abs(comparison.deltaPercent));
  const arrow = comparison.deltaCents === 0 ? '→' : comparison.deltaCents > 0 ? '↑' : '↓';

  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${DIRECTION_CLASS[comparison.direction]}`}>
      <span aria-hidden="true">{arrow}</span>
      <span className="tabular">
        {magnitude}
        {percent ? ` (${percent})` : ''}
      </span>
      <span className="text-muted-foreground font-normal">vs {previousLabel}</span>
    </span>
  );
}
