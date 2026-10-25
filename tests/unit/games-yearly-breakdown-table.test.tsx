import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { YearlyBreakdownTable } from '@/features/games/dashboard/yearly-breakdown-table';
import type { YearlyBreakdownRow } from '@/server/games/stats';

const rows: readonly YearlyBreakdownRow[] = [
  {
    year: 2026,
    startedCount: 13,
    playedCount: 15,
    hoursTenths: 3486,
    achievements: 384,
    hoursChangeTenths: -1833,
  },
  {
    year: 2025,
    startedCount: 10,
    playedCount: 12,
    hoursTenths: 5319,
    achievements: 441,
    hoursChangeTenths: null,
  },
];

function row(name: RegExp): HTMLElement {
  return screen.getByRole('row', { name });
}

/**
 * 2026-10-25: the Total row read 116 started against a Games card saying 167,
 * because 51 games with no first-played year were in no row at all. The
 * table now names them and the Total includes them.
 */
describe('YearlyBreakdownTable', () => {
  it('lists the games with no year as their own line and counts them in the Total', () => {
    render(
      <YearlyBreakdownTable
        rows={rows}
        unattributedTenths={0}
        noYear={{ games: 51, hoursTenths: 148, achievements: 21 }}
        currentYear={2026}
      />,
    );
    const noYear = row(/^No year/);
    expect(within(noYear).getByText('51')).toBeInTheDocument();
    expect(within(noYear).getByText('14.8h')).toBeInTheDocument();
    expect(within(noYear).getByText('21')).toBeInTheDocument();

    const total = row(/^Total/);
    expect(within(total).getByText('74')).toBeInTheDocument(); // 13 + 10 + 51
    expect(within(total).getByText('895.3h')).toBeInTheDocument(); // 348.6 + 531.9 + 14.8
    expect(within(total).getByText('846')).toBeInTheDocument(); // 384 + 441 + 21
  });

  it('omits the No year line when every game has a year', () => {
    render(
      <YearlyBreakdownTable
        rows={rows}
        unattributedTenths={0}
        noYear={{ games: 0, hoursTenths: 0, achievements: 0 }}
        currentYear={2026}
      />,
    );
    expect(screen.queryByText('No year')).not.toBeInTheDocument();
    expect(within(row(/^Total/)).getByText('23')).toBeInTheDocument();
  });
});
