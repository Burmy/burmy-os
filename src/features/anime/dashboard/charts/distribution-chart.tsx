'use client';

import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { TOOLTIP_STYLES, categoryColor } from '@/components/ui/chart-utils';
import { CHART_SLICE_LIMIT, type DistributionSlice, capSlices } from '@/server/anime/stats';

/** `capped.length * 32 + 20` at the capped maximum (limit + one "Other" row) is 308px; this leaves a small margin. */
const MAX_CHART_HEIGHT = 340;

/** Longer than this and the fixed axis collides with the bars. The tooltip still reads the untruncated label off the data item. */
const MAX_LABEL_CHARS = 16;

function truncateLabel(label: string): string {
  return label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS - 1)}…` : label;
}

/**
 * Horizontal bars, not a donut — a donut degrades badly past about six slices,
 * and a real library's genre and studio counts run to dozens.
 *
 * Capped HERE as well as in `stats.ts`, deliberately: the domain cap is what
 * makes the "Other" figure correct, and this one is belt-and-braces so no
 * future caller can hand in an uncapped list and render a 40-row wall.
 *
 * Every bar carries BOTH numbers in its tooltip. "8 shows" and "620 episodes"
 * tell different stories about a studio — one long series and eight films are
 * not the same taste — and a chart that shows only counts hides that.
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

  const capped = capSlices(slices, CHART_SLICE_LIMIT);
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
          {...TOOLTIP_STYLES}
          formatter={(value, _name, item) => {
            const slice = item?.payload as DistributionSlice | undefined;
            const shows = `${String(value)} show${value === 1 ? '' : 's'}`;
            return [slice === undefined ? shows : `${shows} · ${slice.episodes} episodes`, slice?.label ?? ''];
          }}
        />
        <Bar dataKey="count" radius={[0, 4, 4, 0]}>
          {capped.map((slice, index) => (
            <Cell key={slice.label} fill={categoryColor(index)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
