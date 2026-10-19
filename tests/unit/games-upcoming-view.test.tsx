import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const addToWishlistAction = vi.fn(async () => ({ ok: true as const }));
const reconcileWishlistReleaseDatesAction = vi.fn(async () => ({ ok: true as const }));

vi.mock('@/features/games/upcoming/wishlist-actions', () => ({
  addToWishlistAction,
  reconcileWishlistReleaseDatesAction,
}));

vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// The wishlist section opens the game panel and changes statuses; both are
// covered in `games-wishlist-section.test.tsx`. Here they only need to exist.
const openGame = vi.fn();
vi.mock('@/features/games/panel/game-panel-context', () => ({
  useGamePanel: () => ({ openGame, close: vi.fn(), activeId: null }),
}));
vi.mock('@/features/games/game-actions', () => ({
  updateGameFieldAction: vi.fn(async () => ({ ok: true as const })),
}));

/**
 * `restoreMocks: true` (vitest.config.ts) does not reliably clear a mock
 * whose only calls originate from inside a React `useEffect` flushed via
 * `act()` — verified with a minimal repro outside this file: a plain
 * `vi.fn()` called only from a mount effect can still show a PRIOR test's
 * call count at the very start of the next test, before that test's own
 * `render()` even runs. Config-level `restoreMocks` clearly works for
 * ordinary calls (every other mocked Server Action in this suite is fine),
 * so this clears explicitly rather than changing shared config for one
 * narrow case.
 */
beforeEach(() => {
  addToWishlistAction.mockClear();
  reconcileWishlistReleaseDatesAction.mockClear();
});

const { UpcomingView } = await import('@/features/games/upcoming/upcoming-view');

type UpcomingMonth = Parameters<typeof UpcomingView>[0]['months'][number];
type UpcomingMonthGame = UpcomingMonth['games'][number];

function upcomingGame(overrides: Partial<UpcomingMonthGame> = {}): UpcomingMonthGame {
  return {
    igdbId: 1,
    title: 'Fable',
    coverUrl: null,
    hypes: 402,
    platforms: ['ps5'],
    releaseDate: '2026-11-01',
    releasePrecision: 'month',
    ...overrides,
  };
}

function month(overrides: Partial<UpcomingMonth> = {}): UpcomingMonth {
  return {
    key: '2026-11',
    label: 'November 2026',
    games: [upcomingGame()],
    ...overrides,
  };
}

function baseProps(
  overrides: Partial<Parameters<typeof UpcomingView>[0]> = {},
): Parameters<typeof UpcomingView>[0] {
  return {
    months: [month()],
    wishlist: [],
    igdbConfigured: true,
    ...overrides,
  };
}

describe('UpcomingView — month ordering', () => {
  it('renders month sections in the order given, with Later/TBD last', () => {
    render(
      <UpcomingView
        {...baseProps({
          months: [
            month({
              key: '2026-09',
              label: 'September 2026',
              games: [upcomingGame({ igdbId: 1, title: 'September Game' })],
            }),
            month({
              key: '2026-11',
              label: 'November 2026',
              games: [upcomingGame({ igdbId: 2, title: 'November Game' })],
            }),
            month({
              key: 'later',
              label: 'Later / TBD',
              games: [upcomingGame({ igdbId: 3, title: 'TBD Game', releaseDate: null })],
            }),
          ],
        })}
      />,
    );

    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent)
      // 'Your wishlist' sits above the feed on every render — not a month.
      .filter((text) => text !== 'Your wishlist');
    expect(headings).toEqual(['September 2026', 'November 2026', 'Later / TBD']);
  });
});

describe('UpcomingView — release date on the card', () => {
  it('renders a month-precision release date for a dated card', () => {
    render(
      <UpcomingView
        {...baseProps({
          months: [month({ games: [upcomingGame({ releaseDate: '2026-11-01' })] })],
        })}
      />,
    );

    // Appears twice — once as the section header, once on the card itself
    // (new: the card used to omit it entirely, relying solely on which
    // section it happened to render under).
    expect(screen.getAllByText('November 2026')).toHaveLength(2);
  });

  it('renders nothing extra for a Later/TBD card with no known release date', () => {
    render(
      <UpcomingView
        {...baseProps({
          months: [
            month({
              key: 'later',
              label: 'Later / TBD',
              games: [upcomingGame({ title: 'TBD Game', releaseDate: null })],
            }),
          ],
        })}
      />,
    );

    // The section header already says "Later / TBD" — the card itself
    // should not repeat any date text.
    expect(screen.getAllByText('Later / TBD')).toHaveLength(1);
  });
});

describe('UpcomingView — adding to the wishlist', () => {
  it('flips a fresh card from "Add to wishlist" to "Added" only after the server confirms it', async () => {
    addToWishlistAction.mockResolvedValueOnce({ ok: true });
    render(
      <UpcomingView
        {...baseProps({ months: [month({ games: [upcomingGame({ igdbId: 7 })] })] })}
      />,
    );

    const button = screen.getByRole('button', { name: /add to wishlist/i });
    await userEvent.click(button);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^added$/i })).toBeInTheDocument(),
    );
    expect(addToWishlistAction).toHaveBeenCalledWith(
      expect.objectContaining({ igdbId: 7, title: 'Fable', platforms: ['ps5'] }),
    );
  });
});

describe('UpcomingView — Library discoverability hint', () => {
  it("points at the Library for a game IGDB's feed cannot surface, when IGDB is configured", () => {
    render(<UpcomingView {...baseProps({ igdbConfigured: true })} />);

    const link = screen.getByRole('link', { name: 'Library' });
    expect(link).toHaveAttribute('href', '/games/library');
  });

  it('does not show the hint when IGDB is not configured — a different problem', () => {
    render(<UpcomingView {...baseProps({ igdbConfigured: false, months: [] })} />);

    expect(screen.queryByRole('link', { name: 'Library' })).not.toBeInTheDocument();
  });
});

describe('UpcomingView — empty states', () => {
  it('names the IGDB env vars when IGDB is not configured', () => {
    render(<UpcomingView {...baseProps({ igdbConfigured: false, months: [] })} />);

    expect(screen.getByText(/IGDB_CLIENT_ID/)).toBeInTheDocument();
    expect(screen.getByText(/IGDB_CLIENT_SECRET/)).toBeInTheDocument();
  });

  it('shows a cause-agnostic message when IGDB is configured but nothing came back', () => {
    render(<UpcomingView {...baseProps({ igdbConfigured: true, months: [] })} />);

    expect(screen.getByText(/no upcoming games to show/i)).toBeInTheDocument();
    // Must not claim a specific cause it can't actually know — see the
    // component's own doc comment on why `fetchUpcomingGames()` can't tell
    // "genuinely quiet" apart from "the request failed."
    expect(screen.queryByText(/IGDB_CLIENT_ID/)).not.toBeInTheDocument();
  });

  it('shows a per-section message for a month with no games, without dropping the section', () => {
    render(
      <UpcomingView
        {...baseProps({
          months: [
            month({ key: '2026-12', label: 'December 2026', games: [] }),
            month({ key: '2027-01', label: 'January 2027', games: [upcomingGame({ igdbId: 9 })] }),
          ],
        })}
      />,
    );

    expect(screen.getByRole('heading', { name: 'December 2026' })).toBeInTheDocument();
    expect(screen.getByText(/no anticipated releases this month/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'January 2027' })).toBeInTheDocument();
  });
});

describe('UpcomingView — your wishlist', () => {
  const wanted = (
    overrides: Partial<Parameters<typeof UpcomingView>[0]['wishlist'][number]> = {},
  ) => ({
    id: 'w1',
    title: 'Hollow Knight: Silksong',
    platform: 'steam' as const,
    developer: null,
    publisher: null,
    ownership: null,
    priceCents: null,
    status: 'wanted' as const,
    rating: null,
    hoursTenths: null,
    firstPlayedYear: null,
    achievementsUnlocked: null,
    achievementsTotal: null,
    coverUrl: null,
    genre: null,
    notes: null,
    platinum: false,
    metacritic: null,
    averagePlaytimeHours: null,
    esrbRating: null,
    releaseDate: null,
    releasePrecision: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    playYears: [],
    dlc: [],
    collectionId: null,
    ...overrides,
  });

  it('lists the wishlist above the feed, even when IGDB is not configured', () => {
    render(<UpcomingView {...baseProps({ igdbConfigured: false, wishlist: [wanted()] })} />);

    expect(screen.getByRole('heading', { name: 'Your wishlist' })).toBeInTheDocument();
    expect(screen.getByText('Hollow Knight: Silksong')).toBeInTheDocument();
  });

  it('shows an empty line rather than hiding the section when nothing is wanted', () => {
    render(<UpcomingView {...baseProps({ wishlist: [] })} />);
    expect(screen.getByText(/Nothing on your wishlist yet/)).toBeInTheDocument();
  });
});
