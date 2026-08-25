'use client';

import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { TOOLTIP_STYLES, categoryColor } from '@/components/ui/chart-utils';
import { type DistributionSlice, capDistributionSlices } from '@/server/games/stats';

/** Matches `GENRE_CHART_LIMIT` in `stats.ts` — kept as its own constant so this cap holds for EVERY caller (platform, ownership, any future distribution), not only genre. */
const MAX_CHART_SLICES = 8;

/** `slices.length * 32 + 20` at the capped maximum (`MAX_CHART_SLICES` + one "Other" row) is 308px; this leaves a small margin and holds regardless of how the per-row math above it changes later. */
const MAX_CHART_HEIGHT = 340;

/** Longer than this and the fixed 110px axis collides with the bars — truncated with an ellipsis; the full name still shows in the tooltip on hover, since the tooltip reads the untruncated `label` off the data item, not this tick text. */
const MAX_LABEL_CHARS = 16;

function truncateLabel(label: string): string {
  return label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS - 1)}…` : label;
}

/**
 * Horizontal bars, not a donut — a donut degrades badly past ~6 slices, and
 * genre counts routinely exceed that.
 *
 * Caps at `MAX_CHART_SLICES` regardless of what the caller passes in. Genre
 * is capped a second time already, at the source in `buildGenreDistribution`
 * — capping here too is deliberate belt-and-braces so no future distribution
 * (or a change to genre's own cap) can reproduce the multi-thousand-pixel,
 * colliding-label chart this component used to render for every genre
 * COMBINATION in the library.
 */
export function DistributionChart({
  slices,
  emptyMessage,
}: {
  readonly slices: readonly DistributionSlice[];
  readonly emptyMessage: string;
}): React.ReactElement {
  if (slices.length === 0) {
    return <p className="text-muted-foreground py-12 text-center text-sm">{emptyMessage}</p>;
  }

  const capped = capDistributionSlices(slices, MAX_CHART_SLICES);
  const height = Math.min(MAX_CHART_HEIGHT, Math.max(120, capped.length * 32 + 20));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={[...capped]} layout="vertical" margin={{ top: 4, right: 40, left: 8, bottom: 4 }} barCategoryGap={8}>
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="label"
          width={110}
          tick={{ fontSize: 12, fill: 'var(--color-foreground)' }}
          tickLine={false}
          axisLine={false}
          tickFormatter={truncateLabel}
        />
        <Tooltip
          formatter={(value, _name, item) => {
            const percent = (item?.payload as DistributionSlice | undefined)?.percent ?? 0;
            return [`${value} (${percent.toFixed(0)}%)`, 'Games'];
          }}
          {...TOOLTIP_STYLES}
        />
        <Bar dataKey="count" radius={[0, 3, 3, 0]} maxBarSize={22}>
          {capped.map((slice, index) => (
            <Cell key={slice.key} fill={categoryColor(index)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
