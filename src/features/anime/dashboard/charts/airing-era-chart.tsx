'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { TOOLTIP_STYLES, categoryColor } from '@/components/ui/chart-utils';
import type { EraRow } from '@/server/anime/stats';

/**
 * Shows by the year they AIRED — which eras of anime the owner actually
 * watches.
 *
 * Vertical bars because the x-axis is a real number line: years have an order
 * and a gap between 2009 and 2016 means something. The distribution charts are
 * horizontal for the opposite reason — a studio list has no order at all, so
 * the axis is just labels and the long ones need the room.
 *
 * Deliberately NOT a watched-per-year chart. That is a different question and
 * needs the dated watch log; this one must not move when a 2013 show is
 * rewatched in 2026.
 */
export function AiringEraChart({ rows }: { readonly rows: readonly EraRow[] }): React.ReactElement {
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground py-12 text-center text-sm">
        No show in your library has an airing year recorded yet.
      </p>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={[...rows]} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
        <XAxis
          dataKey="year"
          tick={{ fontSize: 12, fill: 'var(--color-muted-foreground)' }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          allowDecimals={false}
          tick={{ fontSize: 12, fill: 'var(--color-muted-foreground)' }}
          tickLine={false}
          axisLine={false}
          width={32}
        />
        <Tooltip
          {...TOOLTIP_STYLES}
          formatter={(value, _name, item) => {
            const row = item?.payload as EraRow | undefined;
            const shows = `${String(value)} show${value === 1 ? '' : 's'}`;
            return [row === undefined ? shows : `${shows} · ${row.episodesWatched} episodes`, 'Aired'];
          }}
        />
        <Bar dataKey="showCount" radius={[4, 4, 0, 0]} fill={categoryColor(0)} />
      </BarChart>
    </ResponsiveContainer>
  );
}
