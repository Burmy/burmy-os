import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const addToWishlistAction = vi.fn(async () => ({ ok: true as const }));
const promoteReleasedWantedGamesAction = vi.fn(async () => ({ ok: true as const }));

vi.mock('@/features/games/upcoming/wishlist-actions', () => ({
  addToWishlistAction,
  promoteReleasedWantedGamesAction,
}));

vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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
  promoteReleasedWantedGamesAction.mockClear();
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

function baseProps(overrides: Partial<Parameters<typeof UpcomingView>[0]> = {}): Parameters<typeof UpcomingView>[0] {
  return {
    months: [month()],
    wishlistedIgdbIds: [],
    overdueWantedCount: 0,
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
            month({ key: '2026-09', label: 'September 2026', games: [upcomingGame({ igdbId: 1, title: 'September Game' })] }),
            month({ key: '2026-11', label: 'November 2026', games: [upcomingGame({ igdbId: 2, title: 'November Game' })] }),
            month({
              key: 'later',
              label: 'Later / TBD',
              games: [upcomingGame({ igdbId: 3, title: 'TBD Game', releaseDate: null })],
            }),
          ],
        })}
      />,
    );

    const headings = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    expect(headings).toEqual(['September 2026', 'November 2026', 'Later / TBD']);
  });
});

describe('UpcomingView — release date on the card', () => {
  it('renders a month-precision release date for a dated card', () => {
    render(<UpcomingView {...baseProps({ months: [month({ games: [upcomingGame({ releaseDate: '2026-11-01' })] })] })} />);

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
            month({ key: 'later', label: 'Later / TBD', games: [upcomingGame({ title: 'TBD Game', releaseDate: null })] }),
          ],
        })}
      />,
    );

    // The section header already says "Later / TBD" — the card itself
    // should not repeat any date text.
    expect(screen.getAllByText('Later / TBD')).toHaveLength(1);
  });
});

describe('UpcomingView — already-wishlisted state', () => {
  it('renders "Added", not the add control, for a game whose igdbId is already wishlisted', () => {
    render(
      <UpcomingView
        {...baseProps({
          months: [month({ games: [upcomingGame({ igdbId: 42, title: 'Grand Theft Auto VI' })] })],
          wishlistedIgdbIds: [42],
        })}
      />,
    );

    expect(screen.getByRole('button', { name: /added/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add to wishlist/i })).not.toBeInTheDocument();
  });

  /**
   * Regression: the "Added" control used to be `disabled` with
   * `variant="secondary"` — the shared `disabled:opacity-50` rule faded an
   * already-modest gray-on-gray pairing to near-illegibility (reported: hard
   * to read, especially in dark theme). It's a permanent success state, not
   * a temporarily-unavailable control, so it must not be `disabled` at all,
   * and must render in the app's emerald "done" register at full opacity.
   */
  it('renders "Added" at full opacity, not as a disabled control', () => {
    render(
      <UpcomingView
        {...baseProps({
          months: [month({ games: [upcomingGame({ igdbId: 42, title: 'Grand Theft Auto VI' })] })],
          wishlistedIgdbIds: [42],
        })}
      />,
    );

    const added = screen.getByRole('button', { name: /added/i });
    expect(added).not.toBeDisabled();
    expect(added.className).toMatch(/emerald/);
  });

  /**
   * Before this treatment, a wishlisted card and a plain one were
   * pixel-identical above the fold — the only difference was the button at
   * the very bottom, invisible while scanning a 7-column grid. This asserts
   * the COVER itself (not just the button) carries a distinguishing class.
   */
  it('gives a wishlisted card a distinct ring on its cover that a plain card does not have', () => {
    const { rerender } = render(
      <UpcomingView
        {...baseProps({
          months: [month({ games: [upcomingGame({ igdbId: 42, title: 'Grand Theft Auto VI' })] })],
          wishlistedIgdbIds: [],
        })}
      />,
    );

    const plainCard = screen.getByRole('button', { name: /add to wishlist/i }).closest('.rounded-lg');
    expect(plainCard?.className).not.toMatch(/ring-violet-400/);

    rerender(
      <UpcomingView
        {...baseProps({
          months: [month({ games: [upcomingGame({ igdbId: 42, title: 'Grand Theft Auto VI' })] })],
          wishlistedIgdbIds: [42],
        })}
      />,
    );

    const wishlistedCard = screen.getByRole('button', { name: /added/i }).closest('.rounded-lg');
    expect(wishlistedCard?.className).toMatch(/ring-violet-400/);
  });

  it('flips a fresh card from "Add to wishlist" to "Added" only after the server confirms it', async () => {
    addToWishlistAction.mockResolvedValueOnce({ ok: true });
    render(<UpcomingView {...baseProps({ months: [month({ games: [upcomingGame({ igdbId: 7 })] })] })} />);

    const button = screen.getByRole('button', { name: /add to wishlist/i });
    await userEvent.click(button);

    await waitFor(() => expect(screen.getByRole('button', { name: /^added$/i })).toBeInTheDocument());
    expect(addToWishlistAction).toHaveBeenCalledWith(
      expect.objectContaining({ igdbId: 7, title: 'Fable', platforms: ['ps5'] }),
    );
  });
});

describe('UpcomingView — Library discoverability hint', () => {
  it('points at the Library for a game IGDB\'s feed cannot surface, when IGDB is configured', () => {
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

describe('UpcomingView — auto-flip on mount', () => {
  it('fires promoteReleasedWantedGamesAction once when the overdue count is non-zero', async () => {
    render(<UpcomingView {...baseProps({ overdueWantedCount: 2 })} />);

    await waitFor(() => expect(promoteReleasedWantedGamesAction).toHaveBeenCalledTimes(1));
  });

  it('never fires promoteReleasedWantedGamesAction when the overdue count is zero', async () => {
    render(<UpcomingView {...baseProps({ overdueWantedCount: 0 })} />);

    // There is nothing to await for a call that should never happen — a
    // microtask flush is enough to prove the mount effect didn't fire it.
    await Promise.resolve();
    expect(promoteReleasedWantedGamesAction).not.toHaveBeenCalled();
  });
});
