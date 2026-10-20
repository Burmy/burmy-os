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
    collectionId: null,
    ...overrides,
  };
}

const rows: readonly GameStatRow[] = [
  game({ id: 'a', title: 'Elden Ring', status: 'played' }),
  game({
    id: 'b',
    title: 'Hades',
    status: 'played',
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
  game({
    id: 'c',
    title: 'Celeste',
    status: 'played',
    hoursTenths: 200,
    rating: 4,
    metacritic: 90,
    priceCents: 1999,
  }),
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
  it('renders Year by year, Trends, and Breakdown as titled Sections', () => {
    render(<GamesDashboard rows={rows} playYears={[]} dlc={[]} currentYear={2026} />);
    for (const title of ['Year by year', 'Trends', 'Breakdown']) {
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    }
  });

  /**
   * Library/Money/Top 3/Highlights used to each be their own boxed, titled
   * `Section` — every one of them is a row of small cards that are ALREADY
   * individually bordered (`StatCard`, `TopGames`), so an outer Section box
   * double-boxed the same information. All four are now bare rows with no
   * heading and no bordering box of their own — matching Finance's own
   * top-row convention exactly (its Income/Expenses/... row, and its
   * `InsightsSection` mini-cards, are both bare too; only Finance's charts
   * and tables get boxed).
   */
  it('does not render Library, Money, Top 3, or Highlights as their own titled Section — those rows are bare', () => {
    render(<GamesDashboard rows={rows} playYears={[]} dlc={[]} currentYear={2026} />);
    for (const title of ['Library', 'Money', 'Top 3', 'Highlights']) {
      expect(screen.queryByRole('heading', { name: title })).not.toBeInTheDocument();
    }
  });

  it('shows two full rows of stat cards: Games, Hours played, Platinums, Trophies earned, Total spend, Cost per hour, This year, Completion', () => {
    render(<GamesDashboard rows={rows} playYears={[]} dlc={[]} currentYear={2026} />);
    for (const label of [
      'Games',
      'Hours played',
      'Platinums',
      'Trophies earned',
      'Total spend',
      'Cost per hour',
      'This year',
      'Completion',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // No longer their own standalone cards — folded into hints instead.
    expect(screen.queryByText('Average rating')).not.toBeInTheDocument();
    expect(screen.queryByText('Average Metacritic')).not.toBeInTheDocument();
    expect(screen.queryByText('Average playtime')).not.toBeInTheDocument();
    expect(screen.queryByText('Average price')).not.toBeInTheDocument();
    expect(screen.queryByText('Backlog value')).not.toBeInTheDocument();
    // There is no backlog status any more — no card, no count, no hint.
    expect(screen.queryByText('Backlog')).not.toBeInTheDocument();
  });

  it('folds average rating and average Metacritic into the Games card hint', () => {
    render(<GamesDashboard rows={rows} playYears={[]} dlc={[]} currentYear={2026} />);
    // rating: (5 + 4) / 2 = 4.5; metacritic: (96 + 90) / 2 = 93.
    expect(screen.getByText(/4\.5★ avg rating/)).toBeInTheDocument();
    expect(screen.getByText(/93 avg Metacritic/)).toBeInTheDocument();
  });

  it('folds average playtime into the Hours played card hint', () => {
    render(<GamesDashboard rows={rows} playYears={[]} dlc={[]} currentYear={2026} />);
    // Hours logged: 1360 and 200 tenths -> average 780 tenths -> 78h.
    expect(screen.getByText(/78h avg per game/)).toBeInTheDocument();
  });

  it('mentions no backlog money under Cost per hour', () => {
    render(<GamesDashboard rows={rows} playYears={[]} dlc={[]} currentYear={2026} />);
    expect(screen.queryByText(/sitting in backlog/)).not.toBeInTheDocument();
  });

  /**
   * The arrow lines (2026-10-19): every card but Cost per hour and Completion
   * compares this year with LAST year — more = green, less = red, no change
   * = grey — and the percentage is of last year's figure, left out when that
   * was zero.
   */
  it('compares this year with last year under Games, Hours, Platinums, Trophies, Total spend and This year', () => {
    const twoYears = [
      game({
        id: 'n',
        title: 'New',
        firstPlayedYear: 2026,
        hoursTenths: 55,
        priceCents: 1000,
        platinum: true,
        achievementsUnlocked: 7,
      }),
      // 2025: 1 started, 100h, 42 trophies (the fixture default), $59.99, no platinum.
      game({ id: 'p', title: 'Prior', firstPlayedYear: 2025, hoursTenths: 1000, platinum: false }),
    ];
    render(
      <GamesDashboard rows={[...rows, ...twoYears]} playYears={[]} dlc={[]} currentYear={2026} />,
    );
    expect(screen.getAllByText('vs 2025')).toHaveLength(6);
    expect(screen.queryByText('this year')).not.toBeInTheDocument();

    const line = (magnitude: string): HTMLElement => {
      const el = screen
        .getAllByText(magnitude)
        .find((candidate) => candidate.parentElement?.textContent?.endsWith('vs 2025'));
      expect(el, magnitude).toBeDefined();
      return el!.parentElement!;
    };
    // Games: 1 started both years → flat, grey, "0 (0%)".
    expect(line('0 (0%)').className).toContain('text-muted-foreground');
    expect(line('0 (0%)').textContent).toContain('→');
    // Hours (twice: Hours played and This year): 5.5h vs 100h → down 94.5h (95%), red.
    expect(screen.getAllByText('94.5h (95%)')).toHaveLength(2);
    expect(line('94.5h (95%)').className).toContain('text-destructive');
    // Platinums: 1 vs 0 → up, green, no percentage of zero.
    expect(line('1').className).toContain('text-[var(--chart-income)]');
    expect(line('1').textContent).toContain('↑');
    // Trophies: 7 vs 42 → down 35 (83%). Spend: $10.00 vs $59.99 → down $49.99 (83%).
    expect(line('35 (83%)').className).toContain('text-destructive');
    expect(line('$49.99 (83%)').className).toContain('text-destructive');
  });

  it('shows no arrow on any card when the year table has no row for last year', () => {
    render(<GamesDashboard rows={rows} playYears={[]} dlc={[]} currentYear={2026} />);
    expect(screen.queryByText(/^vs \d{4}$/)).not.toBeInTheDocument();
    expect(screen.queryByText('this year')).not.toBeInTheDocument();
  });

  it('does not render a "vs. prev" column in the Year by year table', () => {
    render(<GamesDashboard rows={rows} playYears={[]} dlc={[]} currentYear={2026} />);
    expect(screen.queryByText('vs. prev')).not.toBeInTheDocument();
  });

  it('does not render a completion rate card — the field was deleted with the old status model', () => {
    render(<GamesDashboard rows={rows} playYears={[]} dlc={[]} currentYear={2026} />);
    expect(screen.queryByText(/completion rate/i)).not.toBeInTheDocument();
  });

  it('labels every chart inside Trends and Breakdown without nesting a second bordered Section', () => {
    render(<GamesDashboard rows={rows} playYears={[]} dlc={[]} currentYear={2026} />);
    const trends = screen
      .getByRole('heading', { name: 'Trends' })
      .closest('section') as HTMLElement;
    for (const label of ['Games per year', 'Hours per year', 'Trophies per year']) {
      expect(within(trends).getByText(label)).toBeInTheDocument();
    }
    // Chart labels are plain text, not a nested Section heading — the only
    // h2 inside this container is the outer "Trends" Section's own heading.
    expect(within(trends).queryAllByRole('heading', { level: 2 })).toHaveLength(1);

    const breakdown = screen
      .getByRole('heading', { name: 'Breakdown' })
      .closest('section') as HTMLElement;
    for (const label of ['Platforms', 'Physical vs digital', 'Genres', 'Ratings']) {
      expect(within(breakdown).getByText(label)).toBeInTheDocument();
    }
    expect(within(breakdown).queryAllByRole('heading', { level: 2 })).toHaveLength(1);
  });

  it('keeps Top 3 and Highlights intact, as bare rows with no titled Section of their own', () => {
    render(<GamesDashboard rows={rows} playYears={[]} dlc={[]} currentYear={2026} />);
    expect(screen.queryByRole('heading', { name: 'Top 3' })).not.toBeInTheDocument();
    expect(screen.getByText('Most played')).toBeInTheDocument();
    expect(screen.getByText('Highest rated')).toBeInTheDocument();
    expect(screen.getByText('Most trophies')).toBeInTheDocument();
    expect(screen.getByText('Best value')).toBeInTheDocument();

    expect(screen.queryByRole('heading', { name: 'Highlights' })).not.toBeInTheDocument();
    expect(screen.getByText('Most-played developer')).toBeInTheDocument();
    expect(screen.getByText('Best year')).toBeInTheDocument();
  });
});
