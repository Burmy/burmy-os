import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { GamesDashboard } from '@/features/games/dashboard/games-dashboard';
import type { GameStatRow } from '@/server/games/stats';

function game(overrides: Partial<GameStatRow>): GameStatRow {
  return {
    id: 'game-1',
    title: 'Elden Ring',
    platform: 'ps5',
    ownership: 'physical',
    developer: 'FromSoftware, Inc.',
    publisher: 'Bandai Namco Entertainment',
    genre: 'Action RPG',
    coverUrl: null,
    status: 'played',
    rating: 5,
    hoursTenths: 1360,
    firstPlayedYear: 2022,
    achievementsUnlocked: 42,
    achievementsTotal: 42,
    platinum: true,
    metacritic: 96,
    priceCents: 5999,
    ...overrides,
  };
}

const rows: readonly GameStatRow[] = [
  game({ id: 'a', title: 'Elden Ring', status: 'played' }),
  game({
    id: 'b',
    title: 'Hades',
    status: 'backlog',
    platform: 'steam',
    ownership: 'digital',
    genre: 'Roguelike, Action',
    rating: null,
    hoursTenths: null,
    metacritic: null,
    priceCents: 2499,
    platinum: false,
    firstPlayedYear: null,
    achievementsUnlocked: null,
  }),
  game({ id: 'c', title: 'Celeste', status: 'playing', hoursTenths: 200, rating: 4, metacritic: 90, priceCents: 1999 }),
];

/**
 * Section 3 of the redesign trims the old 14-card, 7-chart, unsegmented
 * stats page down to a small headline row plus grouped `Section`s. These
 * tests assert the STRUCTURE of that regrouping, not the charts' internal
 * rendering — Recharts' `ResponsiveContainer` needs real layout measurement
 * that jsdom cannot provide (see `games-distribution-chart.test.tsx`'s doc
 * comment), so chart bar counts are verified by the pure functions in
 * `games-stats.test.ts` and by manual verification, not here.
 */
describe('GamesDashboard', () => {
  it('renders Year by year, Trends, Breakdown, Top 3, and Highlights as titled Sections', () => {
    render(<GamesDashboard rows={rows} playYears={[]} currentYear={2026} />);
    for (const title of ['Year by year', 'Trends', 'Breakdown', 'Top 3', 'Highlights']) {
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    }
  });

  /**
   * Library/Money used to be two separate boxed, titled `Section`s. They're
   * now one bare stat-card row with no heading and no bordering box at
   * all — matching Finance's own top-row convention exactly (its
   * Income/Expenses/... row, and its `InsightsSection` mini-cards, are both
   * bare too; only Finance's charts get boxed).
   */
  it('does not render Library or Money as their own titled Section — the stat-card row is bare', () => {
    render(<GamesDashboard rows={rows} playYears={[]} currentYear={2026} />);
    expect(screen.queryByRole('heading', { name: 'Library' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Money' })).not.toBeInTheDocument();
  });

  it('shows exactly one bare stat-card row of 6: Games, Hours played, Platinums, Backlog, Total spend, Cost per hour', () => {
    render(<GamesDashboard rows={rows} playYears={[]} currentYear={2026} />);
    for (const label of ['Games', 'Hours played', 'Platinums', 'Backlog', 'Total spend', 'Cost per hour']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // No longer their own standalone cards — folded into hints instead.
    expect(screen.queryByText('Average rating')).not.toBeInTheDocument();
    expect(screen.queryByText('Average Metacritic')).not.toBeInTheDocument();
    expect(screen.queryByText('Average playtime')).not.toBeInTheDocument();
    expect(screen.queryByText('Average price')).not.toBeInTheDocument();
    expect(screen.queryByText('Backlog value')).not.toBeInTheDocument();
  });

  it('folds average rating and average Metacritic into the Games card hint', () => {
    render(<GamesDashboard rows={rows} playYears={[]} currentYear={2026} />);
    // rating: (5 + 4) / 2 = 4.5; metacritic: (96 + 90) / 2 = 93.
    expect(screen.getByText(/4\.5★ avg rating/)).toBeInTheDocument();
    expect(screen.getByText(/93 avg Metacritic/)).toBeInTheDocument();
  });

  it('folds average playtime into the Hours played card hint', () => {
    render(<GamesDashboard rows={rows} playYears={[]} currentYear={2026} />);
    // Hours logged: 1360 and 200 tenths -> average 780 tenths -> 78h.
    expect(screen.getByText(/78h avg per game/)).toBeInTheDocument();
  });

  it('folds backlog value into the Cost per hour card hint', () => {
    render(<GamesDashboard rows={rows} playYears={[]} currentYear={2026} />);
    expect(screen.getByText(/sitting in backlog/)).toBeInTheDocument();
  });

  it('does not render a "vs. prev" column in the Year by year table', () => {
    render(<GamesDashboard rows={rows} playYears={[]} currentYear={2026} />);
    expect(screen.queryByText('vs. prev')).not.toBeInTheDocument();
  });

  it('does not render a completion rate card — the field was deleted with the old status model', () => {
    render(<GamesDashboard rows={rows} playYears={[]} currentYear={2026} />);
    expect(screen.queryByText(/completion rate/i)).not.toBeInTheDocument();
  });

  it('labels every chart inside Trends and Breakdown without nesting a second bordered Section', () => {
    render(<GamesDashboard rows={rows} playYears={[]} currentYear={2026} />);
    const trends = screen.getByRole('heading', { name: 'Trends' }).closest('section') as HTMLElement;
    for (const label of ['Games per year', 'Hours per year', 'Trophies per year']) {
      expect(within(trends).getByText(label)).toBeInTheDocument();
    }
    // Chart labels are plain text, not a nested Section heading — the only
    // h2 inside this container is the outer "Trends" Section's own heading.
    expect(within(trends).queryAllByRole('heading', { level: 2 })).toHaveLength(1);

    const breakdown = screen.getByRole('heading', { name: 'Breakdown' }).closest('section') as HTMLElement;
    for (const label of ['Platforms', 'Physical vs digital', 'Genres', 'Ratings']) {
      expect(within(breakdown).getByText(label)).toBeInTheDocument();
    }
    expect(within(breakdown).queryAllByRole('heading', { level: 2 })).toHaveLength(1);
  });

  it('keeps Top 3 and Highlights intact', () => {
    render(<GamesDashboard rows={rows} playYears={[]} currentYear={2026} />);
    const topThree = screen.getByRole('heading', { name: 'Top 3' }).closest('section') as HTMLElement;
    expect(within(topThree).getByText('Most played')).toBeInTheDocument();
    expect(within(topThree).getByText('Highest rated')).toBeInTheDocument();
    expect(within(topThree).getByText('Most trophies')).toBeInTheDocument();
    expect(within(topThree).getByText('Best value')).toBeInTheDocument();

    const highlights = screen.getByRole('heading', { name: 'Highlights' }).closest('section') as HTMLElement;
    expect(within(highlights).getByText('Most-played developer')).toBeInTheDocument();
    expect(within(highlights).getByText('Best year')).toBeInTheDocument();
  });
});
