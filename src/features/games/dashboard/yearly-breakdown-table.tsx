import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { formatHours, hours } from '@/server/games/hours';
import type { YearlyBreakdownRow } from '@/server/games/stats';

/**
 * The direct replacement for the spreadsheet's hand-maintained Year →
 * Games/Hours/Trophies table. Computed from the library on every render, so it
 * cannot drift the way the original did.
 */
export function YearlyBreakdownTable({
  rows,
  unattributedTenths,
  currentYear,
}: {
  readonly rows: readonly YearlyBreakdownRow[];
  readonly unattributedTenths: number;
  readonly currentYear: number;
}): React.ReactElement {
  if (rows.length === 0) {
    return <p className="text-muted-foreground py-8 text-center text-sm">No years to compare yet.</p>;
  }

  const totals = rows.reduce(
    (sum, row) => ({
      startedCount: sum.startedCount + row.startedCount,
      hoursTenths: sum.hoursTenths + row.hoursTenths,
      achievements: sum.achievements + row.achievements,
    }),
    { startedCount: 0, hoursTenths: 0, achievements: 0 },
  );

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Year</TableHead>
          <TableHead className="text-right" title="Games first played this year">
            Started
          </TableHead>
          <TableHead
            className="text-right"
            title="Games with hours recorded in this year, including ones started earlier"
          >
            Played
          </TableHead>
          <TableHead className="text-right">Hours</TableHead>
          <TableHead className="text-right">Achievements</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.year}>
            <TableCell className={cn('font-medium', row.year === currentYear && 'text-foreground')}>
              {row.year}
              {row.year === currentYear ? <span className="text-muted-foreground ml-2 text-xs">in progress</span> : null}
            </TableCell>
            <TableCell className="tabular text-right">{row.startedCount}</TableCell>
            <TableCell className="tabular text-right">{row.playedCount}</TableCell>
            <TableCell className="tabular text-right">{formatHours(hours(row.hoursTenths))}</TableCell>
            <TableCell className="tabular text-right">{row.achievements}</TableCell>
          </TableRow>
        ))}
        {unattributedTenths === 0 ? null : (
          <TableRow className="text-muted-foreground">
            <TableCell
              className="text-sm italic"
              title="Hours recorded on a game whose year-by-year split does not add up to its total"
            >
              Unattributed
            </TableCell>
            <TableCell className="tabular text-right">—</TableCell>
            <TableCell className="tabular text-right">—</TableCell>
            <TableCell className="tabular text-right">
              {unattributedTenths < 0 ? '−' : ''}
              {formatHours(hours(Math.abs(unattributedTenths)))}
            </TableCell>
            <TableCell className="tabular text-right">—</TableCell>
          </TableRow>
        )}
        <TableRow className="bg-muted/40 border-t-2 font-semibold">
          <TableCell>Total</TableCell>
          <TableCell className="tabular text-right">{totals.startedCount}</TableCell>
          <TableCell className="tabular text-right">—</TableCell>
          <TableCell className="tabular text-right">{formatHours(hours(totals.hoursTenths))}</TableCell>
          <TableCell className="tabular text-right">{totals.achievements}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}
