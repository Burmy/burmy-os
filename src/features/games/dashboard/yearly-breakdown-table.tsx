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
  currentYear,
}: {
  readonly rows: readonly YearlyBreakdownRow[];
  readonly currentYear: number;
}): React.ReactElement {
  if (rows.length === 0) {
    return <p className="text-muted-foreground py-8 text-center text-sm">No years to compare yet.</p>;
  }

  const totals = rows.reduce(
    (sum, row) => ({
      gameCount: sum.gameCount + row.gameCount,
      hoursTenths: sum.hoursTenths + row.hoursTenths,
      achievements: sum.achievements + row.achievements,
    }),
    { gameCount: 0, hoursTenths: 0, achievements: 0 },
  );

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Year</TableHead>
          <TableHead className="text-right">Games</TableHead>
          <TableHead className="text-right">Hours</TableHead>
          <TableHead className="text-right">vs. prev</TableHead>
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
            <TableCell className="tabular text-right">{row.gameCount}</TableCell>
            <TableCell className="tabular text-right">{formatHours(hours(row.hoursTenths))}</TableCell>
            <TableCell
              className={cn(
                'tabular text-right text-xs',
                row.hoursChangeTenths === null
                  ? 'text-muted-foreground'
                  : row.hoursChangeTenths >= 0
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-destructive',
              )}
            >
              {row.hoursChangeTenths === null
                ? '—'
                : `${row.hoursChangeTenths >= 0 ? '+' : '−'}${formatHours(hours(Math.abs(row.hoursChangeTenths)))}`}
            </TableCell>
            <TableCell className="tabular text-right">{row.achievements}</TableCell>
          </TableRow>
        ))}
        <TableRow className="bg-muted/40 border-t-2 font-semibold">
          <TableCell>Total</TableCell>
          <TableCell className="tabular text-right">{totals.gameCount}</TableCell>
          <TableCell className="tabular text-right">{formatHours(hours(totals.hoursTenths))}</TableCell>
          <TableCell />
          <TableCell className="tabular text-right">{totals.achievements}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}
