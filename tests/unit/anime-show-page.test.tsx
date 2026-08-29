import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The show page.
 *
 * Its all-or-nothing branches are the progress bar (drawn only when the total
 * is known) and the History section (rendered only when the log has anything),
 * plus the one that only appeared when the page was actually run: Status was
 * on screen TWICE, as a read-only badge above an editable select.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/features/anime/anime-actions', () => ({
  updateAnimeFieldAction: vi.fn(async () => ({ ok: true as const })),
  deleteAnimeAction: vi.fn(async () => ({ ok: true as const })),
  setAnimeSeriesAction: vi.fn(async () => ({ ok: true as const })),
  createSeriesForAnimeAction: vi.fn(async () => ({ ok: true as const })),
}));

const { AnimePage } = await import('@/features/anime/show/anime-page');

type Anime = Parameters<typeof AnimePage>[0]['anime'];
type Entry = Parameters<typeof AnimePage>[0]['history'][number];

function show(overrides: Partial<Anime> = {}): Anime {
  return {
    id: 'a1',
    seriesId: null,
    anilistMediaId: 5114,
    titleRomaji: 'Fullmetal Alchemist: Brotherhood',
    titleEnglish: null,
    format: 'tv',
    status: 'completed',
    episodes: 64,
    progress: 64,
    repeatCount: 1,
    durationMinutes: 24,
    season: 'spring',
    seasonYear: 2009,
    studio: 'Bones',
    genre: 'Action, Drama',
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

function entry(id: string): Entry {
  return {
    id,
    animeId: 'a1',
    title: 'Fullmetal Alchemist: Brotherhood',
    coverUrl: null,
    watchedAt: new Date('2024-03-12T20:15:00'),
    episode: 4,
    kind: 'progress',
  };
}

function renderPage(overrides: Partial<Anime> = {}, history: Entry[] = []): void {
  render(<AnimePage anime={show(overrides)} series={null} seriesOptions={[]} history={history} />);
}

describe('AnimePage — status', () => {
  it('states the status exactly once, and editably', () => {
    // REGRESSION. This shipped with a read-only badge ABOVE an editable
    // select — the same fact twice, with two different controls. Caught by
    // looking at the running page, not by any check.
    renderPage();
    expect(screen.getAllByText('Completed')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Status' })).toBeInTheDocument();
  });
});

describe('AnimePage — the progress bar', () => {
  it('draws one when the episode total is known', () => {
    renderPage({ progress: 32, episodes: 64 });
    const bar = screen.getByRole('progressbar', { name: '32 of 64 episodes watched' });
    expect(bar).toHaveAttribute('aria-valuenow', '50');
  });

  it('draws none for an airing show with no published total', () => {
    // There is no fraction to draw, and a full-width bar would claim one.
    renderPage({ progress: 1094, episodes: null });
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByText('1094 episodes')).toBeInTheDocument();
  });
});

describe('AnimePage — derived figures', () => {
  it('reports what the rewatches add up to', () => {
    renderPage({ episodes: 64, progress: 64, repeatCount: 1 });
    expect(screen.getByText('128 episodes watched in total')).toBeInTheDocument();
  });

  it('says nothing extra when nothing was rewatched', () => {
    renderPage({ repeatCount: 0 });
    expect(screen.queryByText(/episodes watched in total/)).not.toBeInTheDocument();
  });

  it('labels time watched an estimate every time it appears', () => {
    renderPage();
    expect(screen.getByText(/^≈/)).toBeInTheDocument();
    expect(screen.getByText('Estimated from an average episode length, not measured.')).toBeInTheDocument();
  });

  it('says "Unknown" — never a zero — when the episode length is not known', () => {
    // Scoped to the Time watched row: "Unknown" is also the placeholder on
    // Episodes and Year, which is correct in all three places and would make a
    // bare `getByText` ambiguous.
    renderPage({ durationMinutes: null });
    const row = screen.getByText('Time watched').parentElement as HTMLElement;
    expect(within(row).getByText('Unknown')).toBeInTheDocument();
    expect(screen.queryByText(/^≈/)).not.toBeInTheDocument();
  });
});

describe('AnimePage — history', () => {
  it('shows the section once the log has something for this show', () => {
    renderPage({}, [entry('e1'), entry('e2')]);
    expect(screen.getByRole('heading', { name: 'History' })).toBeInTheDocument();
  });

  it('omits it entirely when there is nothing', () => {
    // A permanent blank panel on every hand-added show, and on everything
    // watched before AniList's feed reaches, explains nothing. The Log tab is
    // where the feed's limits are stated once.
    renderPage();
    expect(screen.queryByRole('heading', { name: 'History' })).not.toBeInTheDocument();
  });
});

describe('AnimePage — removal', () => {
  it('names the show and says the history goes with it', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: /Remove/ }));
    expect(
      screen.getByText('This deletes the entry and its watch history from your library. This can\'t be undone.'),
    ).toBeInTheDocument();
  });
});
