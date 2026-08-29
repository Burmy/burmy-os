import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The Anime dashboard, rendered.
 *
 * A PURE-FUNCTION SUITE DOES NOT TELL YOU THE PAGE RENDERS. The Finance
 * dashboard shipped two bugs behind 1,267 green unit tests, a clean typecheck
 * and a clean lint, because no test anywhere rendered it — correct functions
 * composing into a screen that contradicted itself. Every all-or-nothing
 * branch here gets a case asserting which block is actually on screen.
 */

// Recharts needs real layout; jsdom has none, so both charts are stubbed to
// something assertable. What is under test is the DASHBOARD's branching and
// its wording, not Recharts.
vi.mock('@/features/anime/dashboard/charts/distribution-chart', () => ({
  DistributionChart: ({ slices, emptyMessage }: { slices: readonly { label: string }[]; emptyMessage: string }) =>
    slices.length === 0 ? <p>{emptyMessage}</p> : <div data-testid="distribution">{slices.map((s) => s.label).join(',')}</div>,
}));
vi.mock('@/features/anime/dashboard/charts/airing-era-chart', () => ({
  AiringEraChart: ({ rows }: { rows: readonly { year: number }[] }) => (
    <div data-testid="eras">{rows.map((r) => r.year).join(',')}</div>
  ),
}));

const { AnimeDashboard } = await import('@/features/anime/dashboard/anime-dashboard');

type Row = Parameters<typeof AnimeDashboard>[0]['rows'][number];

function show(overrides: Partial<Row> & { readonly id: string }): Row {
  return {
    titleRomaji: overrides.id,
    titleEnglish: null,
    status: 'completed',
    format: 'tv',
    source: 'manga',
    episodes: 12,
    progress: 12,
    repeatCount: 0,
    durationMinutes: 24,
    season: 'spring',
    seasonYear: 2020,
    studio: 'Studio Ghost',
    genre: 'Action, Drama',
    coverUrl: null,
    ...overrides,
  };
}

describe('AnimeDashboard — the empty branch', () => {
  it('renders one honest "nothing yet" instead of a row of zeroes', () => {
    // The exact defect the Finance dashboard shipped: correct functions
    // producing a wall of `0`s that contradicted the page around them.
    render(<AnimeDashboard rows={[]} />);

    expect(screen.getByText('No stats yet.')).toBeInTheDocument();
    expect(screen.queryByText('Shows')).not.toBeInTheDocument();
    expect(screen.queryByText('Episodes watched')).not.toBeInTheDocument();
    expect(screen.queryByTestId('eras')).not.toBeInTheDocument();
  });
});

describe('AnimeDashboard — the populated branch', () => {
  const ROWS: Row[] = [
    show({ id: 'a', episodes: 25, progress: 25, repeatCount: 2, seasonYear: 2013, studio: 'Wit Studio' }),
    show({ id: 'b', episodes: 12, progress: 12, seasonYear: 2020 }),
    show({ id: 'c', status: 'dropped', episodes: 148, progress: 60, seasonYear: 2011, studio: 'Madhouse' }),
    show({ id: 'd', status: 'planning', progress: 0, seasonYear: 2024 }),
  ];

  it('shows the stat cards and the charts', () => {
    render(<AnimeDashboard rows={ROWS} />);

    expect(screen.getByText('Shows')).toBeInTheDocument();
    expect(screen.getByText('Episodes watched')).toBeInTheDocument();
    expect(screen.getByText('Time watched')).toBeInTheDocument();
    expect(screen.getByText('Completion rate')).toBeInTheDocument();
    expect(screen.getByTestId('eras')).toHaveTextContent('2011,2013,2020,2024');
    expect(screen.queryByText('No stats yet.')).not.toBeInTheDocument();
  });

  it('breaks the show count down by status in its hint', () => {
    render(<AnimeDashboard rows={ROWS} />);
    expect(screen.getByText('0 watching · 2 completed · 1 dropped · 1 planning')).toBeInTheDocument();
  });

  it('attributes the rewatch share of the episode total', () => {
    render(<AnimeDashboard rows={ROWS} />);
    expect(screen.getByText('50 from rewatching 1 show')).toBeInTheDocument();
  });

  it('says nothing about rewatches when there are none', () => {
    render(<AnimeDashboard rows={[show({ id: 'a' })]} />);
    expect(screen.queryByText(/from rewatching/)).not.toBeInTheDocument();
  });

  it('always labels time watched an estimate, never a measurement', () => {
    render(<AnimeDashboard rows={ROWS} />);
    expect(screen.getByText('Estimated from average episode lengths.')).toBeInTheDocument();
  });

  it('says how many shows were left out of that estimate', () => {
    render(<AnimeDashboard rows={[show({ id: 'a' }), show({ id: 'b', durationMinutes: null })]} />);
    expect(
      screen.getByText('Estimated — 1 show with no known episode length is not counted.'),
    ).toBeInTheDocument();
  });

  it('renders a dash, not "0h", when no show has a known episode length', () => {
    // "0h watched" over a real library is a lie; "—" is the truth.
    render(<AnimeDashboard rows={[show({ id: 'a', durationMinutes: null })]} />);
    expect(screen.getByText('No show has a known episode length yet.')).toBeInTheDocument();
  });
});

describe('AnimeDashboard — completion rate', () => {
  it('renders a dash, not 0%, when nothing has been started', () => {
    // Nothing started and nothing finished are different facts.
    render(<AnimeDashboard rows={[show({ id: 'a', status: 'planning' })]} />);
    expect(screen.getByText('Nothing started yet.')).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it('excludes planning entries from the rate', () => {
    render(
      <AnimeDashboard
        rows={[
          show({ id: 'a', status: 'completed' }),
          show({ id: 'b', status: 'dropped' }),
          show({ id: 'c', status: 'planning' }),
          show({ id: 'd', status: 'planning' }),
        ]}
      />,
    );
    expect(screen.getByText('of 2 started · 50% dropped')).toBeInTheDocument();
  });
});

describe('AnimeDashboard — the leaderboard', () => {
  it('ranks by episodes watched and links each entry to its show', () => {
    render(
      <AnimeDashboard
        rows={[
          show({ id: 'short', titleRomaji: 'Short', episodes: 12, progress: 12 }),
          show({ id: 'long', titleRomaji: 'Long', episodes: 64, progress: 64 }),
        ]}
      />,
    );

    const list = screen.getByRole('link', { name: /Long/ });
    expect(list).toHaveAttribute('href', '/anime/long');
  });

  it('omits the time estimate for an entry with no known episode length, rather than printing zero', () => {
    render(<AnimeDashboard rows={[show({ id: 'a', titleRomaji: 'Unknown Length', durationMinutes: null })]} />);
    const link = screen.getByRole('link', { name: /Unknown Length/ });
    expect(link.textContent).toContain('12 eps');
    expect(link.textContent).not.toContain('≈');
  });

  it('says so plainly when nothing has been watched at all', () => {
    render(<AnimeDashboard rows={[show({ id: 'a', status: 'planning', progress: 0 })]} />);
    expect(screen.getByText('Nothing watched yet.')).toBeInTheDocument();
  });
});

describe('AnimeDashboard — distributions', () => {
  it('says the genre slices do not sum to the library, because a show counts in each', () => {
    render(<AnimeDashboard rows={[show({ id: 'a' })]} />);
    expect(screen.getByText(/A show counts in every genre it carries, so these do not sum/)).toBeInTheDocument();
  });

  it("says the era chart is about when a show AIRED, not when it was watched", () => {
    render(<AnimeDashboard rows={[show({ id: 'a' })]} />);
    expect(screen.getByText(/not the year you watched it — so a rewatch never moves a bar/)).toBeInTheDocument();
  });

  it('offers each chart its own empty message rather than a blank panel', () => {
    render(<AnimeDashboard rows={[show({ id: 'a', studio: null, genre: null, format: null, source: null })]} />);
    expect(screen.getByText('No show has a studio recorded yet.')).toBeInTheDocument();
    expect(screen.getByText('No show has genres recorded yet.')).toBeInTheDocument();
    expect(screen.getByText('No show has a format recorded yet.')).toBeInTheDocument();
    expect(screen.getByText('No show has a source recorded yet.')).toBeInTheDocument();
  });
});
