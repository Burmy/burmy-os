import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

/**
 * The Series tab.
 *
 * It exists because a franchise used to be reachable only sideways — a link in
 * the library's table, or by already knowing to pick it in a filter dropdown.
 * A nesting nobody can browse is a data model, not a feature.
 */

const navigate = vi.fn();
vi.mock('@/lib/use-navigate', () => ({ useNavigate: () => ({ navigate, pending: false }) }));

const { SeriesListView } = await import('@/features/anime/series/series-list-view');

type Row = Parameters<typeof SeriesListView>[0]['series'][number];
type Member = Row['members'][number];

function member(overrides: Partial<Member> & { readonly id: string }): Member {
  return {
    seriesId: 'aot',
    anilistMediaId: null,
    titleRomaji: overrides.id,
    titleEnglish: null,
    format: 'tv',
    status: 'completed',
    episodes: 12,
    progress: 12,
    repeatCount: 0,
    durationMinutes: 24,
    season: 'spring',
    seasonYear: 2013,
    studio: null,
    genre: null,
    source: null,
    synopsis: null,
    coverUrl: null,
    notes: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

const AOT: Row = {
  series: { id: 'aot', title: 'Attack on Titan', coverUrl: null, notes: null, anilistParentId: 16498 },
  members: [
    member({ id: 's1', titleRomaji: 'Shingeki no Kyojin', episodes: 25, progress: 25, seasonYear: 2013 }),
    member({ id: 's2', titleRomaji: 'Shingeki no Kyojin Season 2', seasonYear: 2017 }),
    member({ id: 's3', titleRomaji: 'Shingeki no Kyojin Season 3', seasonYear: 2018 }),
  ],
};

const MOB: Row = {
  series: { id: 'mob', title: 'Mob Psycho 100', coverUrl: null, notes: null, anilistParentId: null },
  members: [member({ id: 'm1', seriesId: 'mob', titleRomaji: 'Mob Psycho 100', seasonYear: 2016 })],
};

describe('SeriesListView — the empty branch', () => {
  it('names both ways to make a series rather than showing an empty grid', () => {
    render(<SeriesListView series={[]} />);
    expect(screen.getByText(/use “Part of” to start one, or approve a grouping/)).toBeInTheDocument();
  });

  it('offers no search box when there is nothing to search', () => {
    render(<SeriesListView series={[]} />);
    expect(screen.queryByRole('textbox', { name: 'Search series' })).not.toBeInTheDocument();
  });
});

describe('SeriesListView — the cards', () => {
  it('counts series and the shows grouped under them separately', () => {
    // Two different numbers that a single count would blur: a franchise is not
    // a show, and the library's own count must never disagree with this page.
    render(<SeriesListView series={[AOT, MOB]} />);
    expect(screen.getByText('2 series')).toBeInTheDocument();
    expect(screen.getByText('· 4 shows grouped')).toBeInTheDocument();
  });

  it('names the seasons on the card, which is the nesting made visible', () => {
    // A card that only said "3 shows" would hide the one thing the owner is
    // checking — WHICH three.
    render(<SeriesListView series={[AOT]} />);
    expect(screen.getByText('Shingeki no Kyojin')).toBeInTheDocument();
    expect(screen.getByText('Shingeki no Kyojin Season 2')).toBeInTheDocument();
  });

  it('caps the season list so one long franchise does not set every row height', () => {
    const long: Row = {
      series: AOT.series,
      members: Array.from({ length: 9 }, (_, i) => member({ id: `s${i}`, titleRomaji: `Season ${i}` })),
    };
    render(<SeriesListView series={[long]} />);
    expect(screen.getByText('+6 more')).toBeInTheDocument();
  });

  it('labels time watched an estimate, in the accessible name too', () => {
    render(<SeriesListView series={[AOT]} />);
    const card = screen.getByRole('button', { name: /Attack on Titan/ });
    expect(card.getAttribute('aria-label')).toMatch(/3 shows · 49 eps · ≈/);
  });

  it('gives the card a readable accessible name rather than a run-together one', () => {
    // Five sibling elements; a computed name would join them each TRIMMED into
    // "Attack on Titan2013–20183 shows". See CLAUDE.md.
    render(<SeriesListView series={[AOT]} />);
    expect(screen.getByRole('button', { name: /^Attack on Titan, 2013–2018 — / })).toBeInTheDocument();
  });

  it('collapses the airing span when every season aired in one year', () => {
    render(<SeriesListView series={[MOB]} />);
    expect(screen.getByRole('button', { name: /Mob Psycho 100, 2016 — 1 show/ })).toBeInTheDocument();
  });

  it('opens the series page on click', async () => {
    const user = userEvent.setup();
    render(<SeriesListView series={[AOT]} />);

    await user.click(screen.getByRole('button', { name: /Attack on Titan/ }));
    expect(navigate).toHaveBeenCalledWith('/anime/series/aot');
  });
});

describe('SeriesListView — search', () => {
  it('finds a franchise by its own name', async () => {
    const user = userEvent.setup();
    render(<SeriesListView series={[AOT, MOB]} />);

    await user.type(screen.getByRole('textbox', { name: 'Search series' }), 'mob');
    expect(screen.getByText('1 of 2 series')).toBeInTheDocument();
  });

  it('finds it by a SEASON’s name too', async () => {
    // How anyone actually looks for one: you remember "Season 3", not the base
    // title the grouping heuristic produced.
    const user = userEvent.setup();
    render(<SeriesListView series={[AOT, MOB]} />);

    await user.type(screen.getByRole('textbox', { name: 'Search series' }), 'Season 3');
    expect(screen.getByText('1 of 2 series')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Attack on Titan/ })).toBeInTheDocument();
  });

  it('says a search matched nothing rather than looking empty', async () => {
    const user = userEvent.setup();
    render(<SeriesListView series={[AOT]} />);

    await user.type(screen.getByRole('textbox', { name: 'Search series' }), 'zzzz');
    expect(screen.getByText('No series matches that search.')).toBeInTheDocument();
  });
});

describe('SeriesListView — an empty series', () => {
  it('is still listed, because it is a real state that must stay reachable', () => {
    const empty: Row = {
      series: { id: 'e', title: 'Empty', coverUrl: null, notes: null, anilistParentId: null },
      members: [],
    };
    render(<SeriesListView series={[empty]} />);
    expect(screen.getByRole('button', { name: /Empty — 0 shows/ })).toBeInTheDocument();
  });
});
