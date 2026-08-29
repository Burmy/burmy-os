import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

/**
 * The library screen.
 *
 * Render tests rather than pure-function tests because this screen has several
 * all-or-nothing branches — empty library, empty filter result, gallery vs
 * table — and the discipline this codebase adopted after the Finance dashboard
 * shipped two bugs behind 1,267 green unit tests is that such a branch gets a
 * test asserting which block is actually on screen.
 */

const navigate = vi.fn();
vi.mock('@/lib/use-navigate', () => ({ useNavigate: () => ({ navigate, pending: false }) }));

const addAnimeToSeriesAction = vi.fn(async () => ({ ok: true as const }));
vi.mock('@/features/anime/anime-actions', () => ({
  addAnimeToSeriesAction: (...args: unknown[]) => addAnimeToSeriesAction(...(args as [])),
  createAnimeAction: vi.fn(async () => ({ ok: true as const })),
}));

vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { AnimeLibraryView } = await import('@/features/anime/library/library-view');

type Anime = Parameters<typeof AnimeLibraryView>[0]['anime'][number];
type Series = Parameters<typeof AnimeLibraryView>[0]['series'][number];

const SERIES: Series[] = [
  { id: 'aot', title: 'Attack on Titan', coverUrl: null, anilistParentId: null },
];

function show(overrides: Partial<Anime> & { readonly id: string }): Anime {
  return {
    seriesId: null,
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
    seasonYear: 2020,
    studio: 'Studio Ghost',
    genre: 'Action',
    source: 'manga',
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

const LIBRARY: Anime[] = [
  show({ id: 's1', titleRomaji: 'Shingeki no Kyojin', titleEnglish: 'Attack on Titan', seriesId: 'aot', episodes: 25, progress: 25, repeatCount: 2 }),
  show({ id: 's2', titleRomaji: 'Shingeki no Kyojin Season 2', seriesId: 'aot' }),
  show({ id: 'op', titleRomaji: 'One Piece', status: 'watching', episodes: null, progress: 1094 }),
  show({ id: 'hxh', titleRomaji: 'Hunter x Hunter', status: 'dropped', episodes: 148, progress: 60, studio: 'Madhouse' }),
];

describe('AnimeLibraryView — the empty branches', () => {
  it('points at both ways to fill an empty library', () => {
    render(<AnimeLibraryView anime={[]} series={[]} />);
    expect(screen.getByText(/Sync from AniList in Settings, or add a show by hand/)).toBeInTheDocument();
  });

  it('says a filter matched nothing, not that the library is empty', async () => {
    // Two very different situations that a single "nothing here" would blur.
    const user = userEvent.setup();
    render(<AnimeLibraryView anime={LIBRARY} series={SERIES} />);

    await user.type(screen.getByRole('textbox', { name: 'Search anime' }), 'zzzz');
    expect(screen.getByText('No anime matches this filter.')).toBeInTheDocument();
    expect(screen.queryByText(/Sync from AniList/)).not.toBeInTheDocument();
  });
});

describe('AnimeLibraryView — the header', () => {
  it('counts shows and estimates time watched', () => {
    render(<AnimeLibraryView anime={LIBRARY} series={SERIES} />);
    expect(screen.getByText('4 shows')).toBeInTheDocument();
    // Never a bare figure: `duration` is an average AniList publishes, not a
    // measurement of what was watched.
    expect(screen.getByText(/≈.* watched/)).toBeInTheDocument();
  });

  it('shows "n of m" once a filter is on', async () => {
    const user = userEvent.setup();
    render(<AnimeLibraryView anime={LIBRARY} series={SERIES} />);

    await user.click(screen.getByRole('button', { name: 'Dropped, 1' }));
    expect(screen.getByText('1 of 4 shows')).toBeInTheDocument();
  });
});

describe('AnimeLibraryView — series', () => {
  it('names the franchise on a card, so three near-identical covers are not three unrelated shows', () => {
    render(<AnimeLibraryView anime={LIBRARY} series={SERIES} />);
    expect(screen.getAllByText('Attack on Titan').length).toBeGreaterThan(0);
  });

  it("puts the franchise in a card's accessible name too", () => {
    render(<AnimeLibraryView anime={LIBRARY} series={SERIES} />);
    expect(
      screen.getByRole('button', { name: /Attack on Titan — Completed, 25 \/ 25, rewatched 2x, part of Attack on Titan/ }),
    ).toBeInTheDocument();
  });

  it('offers no series filter at all when there are no series', () => {
    render(<AnimeLibraryView anime={LIBRARY} series={[]} />);
    expect(screen.queryByRole('combobox', { name: 'Series' })).not.toBeInTheDocument();
  });

  it('links to the series page once the filter names exactly one', async () => {
    // Without this the filter is a dead end: it can show the seasons of a
    // franchise and give no way to reach the franchise itself.
    const user = userEvent.setup();
    render(<AnimeLibraryView anime={LIBRARY} series={SERIES} />);

    expect(screen.queryByRole('link', { name: /Open Attack on Titan/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Series' }));
    await user.click(screen.getByRole('option', { name: 'Attack on Titan' }));

    expect(screen.getByRole('link', { name: /Open Attack on Titan/ })).toHaveAttribute(
      'href',
      '/anime/series/aot',
    );
  });

  it('filters to the shows with no series at all', async () => {
    const user = userEvent.setup();
    render(<AnimeLibraryView anime={LIBRARY} series={SERIES} />);

    await user.click(screen.getByRole('combobox', { name: 'Series' }));
    await user.click(screen.getByRole('option', { name: 'Not in a series' }));

    expect(screen.getByText('2 of 4 shows')).toBeInTheDocument();
  });
});

describe('AnimeLibraryView — the table view', () => {
  it('switches between gallery and table', async () => {
    const user = userEvent.setup();
    render(<AnimeLibraryView anime={LIBRARY} series={SERIES} />);

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Table view' }));
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('is the only view that links a row to its series', async () => {
    // The gallery card is a `<button>`; a link nested in a button is invalid
    // HTML, which is why the card carries plain text and the table the link.
    const user = userEvent.setup();
    render(<AnimeLibraryView anime={LIBRARY} series={SERIES} />);
    await user.click(screen.getByRole('button', { name: 'Table view' }));

    const row = screen.getByRole('row', { name: /Shingeki no Kyojin Season 2/ });
    expect(within(row).getByRole('link', { name: 'Attack on Titan' })).toHaveAttribute(
      'href',
      '/anime/series/aot',
    );
  });

  it('offers the bulk bar only once rows are selected', async () => {
    const user = userEvent.setup();
    render(<AnimeLibraryView anime={LIBRARY} series={SERIES} />);
    await user.click(screen.getByRole('button', { name: 'Table view' }));

    expect(screen.queryByText(/\d+ selected/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Select One Piece' }));
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('never offers the bulk bar in the gallery, where nothing can be selected', async () => {
    const user = userEvent.setup();
    render(<AnimeLibraryView anime={LIBRARY} series={SERIES} />);
    await user.click(screen.getByRole('button', { name: 'Table view' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select One Piece' }));
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Gallery view' }));
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
  });

  it('selects every row currently shown, not every row in the library', async () => {
    // Filtering away a selected row and then bulk-filing would move something
    // the owner can no longer see.
    const user = userEvent.setup();
    render(<AnimeLibraryView anime={LIBRARY} series={SERIES} />);
    await user.click(screen.getByRole('button', { name: 'Table view' }));
    await user.click(screen.getByRole('button', { name: 'Dropped, 1' }));

    await user.click(screen.getByRole('checkbox', { name: 'Select every show shown' }));
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });
});

describe('AnimeLibraryView — progress rendering', () => {
  it('shows a bare episode count when the show has no known total', () => {
    // An airing show with no published episode count has no fraction to draw,
    // and "1094 / 0" would be worse than useless.
    render(<AnimeLibraryView anime={LIBRARY} series={SERIES} />);
    expect(screen.getByText('1094 eps')).toBeInTheDocument();
  });

  it('reports rewatches as a multiplier and a total', () => {
    render(<AnimeLibraryView anime={LIBRARY} series={SERIES} />);
    expect(screen.getByText(/25 \/ 25 · ×3 · 75 total/)).toBeInTheDocument();
  });
});
