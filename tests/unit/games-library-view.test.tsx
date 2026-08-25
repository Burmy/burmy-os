import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const deleteGameAction = vi.fn(async () => ({ ok: true as const }));
const createGameAction = vi.fn(async () => ({ ok: true as const }));
const updateGameAction = vi.fn(async () => ({ ok: true as const }));

vi.mock('@/features/games/game-actions', () => ({
  deleteGameAction,
  createGameAction,
  updateGameAction,
}));

vi.mock('@/features/games/metadata-actions', () => ({
  searchGameMetadataAction: vi.fn(async () => []),
}));

vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// The header renders `SyncButton` and `PsnSyncButton` (Tasks 6 and PSN Task 4)
// unconditionally now, and both call `useRouter()` even when their own click
// handler is never exercised — these tests don't render inside a real
// Next.js app router, so it needs a mock like every other `next/navigation`
// usage in this suite.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const { LibraryView } = await import('@/features/games/library/library-view');

type Game = Parameters<typeof LibraryView>[0]['games'][number];

function game(overrides: Partial<Game>): Game {
  return {
    id: 'game-1',
    title: 'Elden Ring',
    platform: 'ps5',
    developer: 'FromSoftware, Inc.',
    publisher: 'Bandai Namco',
    ownership: 'physical',
    priceCents: 6565,
    status: 'completed',
    rating: 5,
    hoursTenths: 1360,
    firstPlayedYear: 2022,
    achievementsUnlocked: 42,
    achievementsTotal: 42,
    coverUrl: null,
    genre: 'Action RPG',
    notes: null,
    platinum: false,
    metacritic: null,
    averagePlaytimeHours: null,
    esrbRating: null,
    steamAppid: null,
    psnTitleId: null,
    psnNpCommunicationId: null,
    lastPlayedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    playYears: [],
    ...overrides,
  };
}

describe('LibraryView', () => {
  it('renders every game in the default gallery view', () => {
    render(<LibraryView games={[game({ id: 'a', title: 'Elden Ring' }), game({ id: 'b', title: 'Prey' })]} />);

    expect(screen.getByText('Elden Ring')).toBeInTheDocument();
    expect(screen.getByText('Prey')).toBeInTheDocument();
  });

  it('switches to a table view without losing any games', async () => {
    render(<LibraryView games={[game({ id: 'a', title: 'Elden Ring' })]} />);

    await userEvent.click(screen.getByRole('button', { name: /table view/i }));

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('Elden Ring')).toBeInTheDocument();
  });

  it('opens the editor from the table view by keyboard, not just by clicking the row', async () => {
    render(<LibraryView games={[game({ id: 'a', title: 'Elden Ring' })]} />);

    await userEvent.click(screen.getByRole('button', { name: /table view/i }));

    // The row itself is not a focusable control — a real button inside the
    // title cell is, so this is what tab order actually lands on.
    screen.getByRole('button', { name: 'Elden Ring' }).focus();
    await userEvent.keyboard('{Enter}');

    expect(screen.getByRole('heading', { name: 'Elden Ring', level: 2 })).toBeInTheDocument();
  });

  it('filters by status', async () => {
    render(
      <LibraryView
        games={[
          game({ id: 'a', title: 'Finished Game', status: 'completed' }),
          game({ id: 'b', title: 'Queued Game', status: 'backlog' }),
        ]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /^backlog/i }));

    expect(screen.getByText('Queued Game')).toBeInTheDocument();
    expect(screen.queryByText('Finished Game')).not.toBeInTheDocument();
  });

  it('filters by platform', async () => {
    render(
      <LibraryView
        games={[
          game({ id: 'a', title: 'Console Game', platform: 'ps5' }),
          game({ id: 'b', title: 'Desktop Game', platform: 'steam' }),
        ]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /^steam/i }));

    expect(screen.getByText('Desktop Game')).toBeInTheDocument();
    expect(screen.queryByText('Console Game')).not.toBeInTheDocument();
  });

  it('combines status and platform filters', async () => {
    render(
      <LibraryView
        games={[
          game({ id: 'a', title: 'Match', status: 'completed', platform: 'steam' }),
          game({ id: 'b', title: 'Wrong status', status: 'backlog', platform: 'steam' }),
          game({ id: 'c', title: 'Wrong platform', status: 'completed', platform: 'ps5' }),
        ]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /^completed/i }));
    await userEvent.click(screen.getByRole('button', { name: /^steam/i }));

    expect(screen.getByText('Match')).toBeInTheDocument();
    expect(screen.queryByText('Wrong status')).not.toBeInTheDocument();
    expect(screen.queryByText('Wrong platform')).not.toBeInTheDocument();
  });

  it('shows a searchable count that reflects the active filter', async () => {
    render(
      <LibraryView
        games={[
          game({ id: 'a', title: 'Finished Game', status: 'completed' }),
          game({ id: 'b', title: 'Queued Game', status: 'backlog' }),
        ]}
      />,
    );

    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'Queued');

    expect(screen.getByText('Queued Game')).toBeInTheDocument();
    expect(screen.queryByText('Finished Game')).not.toBeInTheDocument();
  });

  it('does not render a platform filter chip for a platform with zero games', () => {
    render(<LibraryView games={[game({ id: 'a', platform: 'ps5' })]} />);

    expect(screen.getByRole('button', { name: /^ps5/i })).toBeInTheDocument();
    // steam, psp, pc, other all have zero games in this library — none of
    // their chips should exist at all, not just be inactive.
    expect(screen.queryByRole('button', { name: /^steam/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^psp/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^pc/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^other/i })).not.toBeInTheDocument();
  });

  it('does not render a status filter chip for a status with zero games', () => {
    render(<LibraryView games={[game({ id: 'a', status: 'completed' })]} />);

    expect(screen.getByRole('button', { name: /^completed/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^backlog/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^playing/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^paused/i })).not.toBeInTheDocument();
  });

  it('labels the steam platform chip "Steam / PC"', () => {
    render(<LibraryView games={[game({ id: 'a', platform: 'steam' })]} />);
    expect(screen.getByRole('button', { name: /^steam \/ pc/i })).toBeInTheDocument();
  });

  /**
   * The three "All …" chips were removed — they spent permanent slots
   * restating a total the header already prints, and one of them headed a
   * Source group whose "Steam" chip meant something different from the
   * "Steam / PC" platform chip beside it. Clearing a filter now happens by
   * toggling the active chip, or via a "Clear" that appears only while
   * something is filtered.
   */
  it('clears a filter when its own active chip is clicked again', async () => {
    render(
      <LibraryView
        games={[
          game({ id: 'a', title: 'Astro Bot', platform: 'ps5' }),
          game({ id: 'b', title: 'Daxter', platform: 'psp' }),
        ]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /^ps5\d/i }));
    expect(screen.queryByText('Daxter')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^ps5\d/i }));
    expect(screen.getByText('Daxter')).toBeInTheDocument();
  });

  it('offers Clear only while something is actually filtered', async () => {
    render(<LibraryView games={[game({ id: 'a', platform: 'ps5' }), game({ id: 'b', platform: 'psp' })]} />);

    expect(screen.queryByRole('button', { name: /^clear$/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^ps5\d/i }));
    await userEvent.click(screen.getByRole('button', { name: /^clear$/i }));

    expect(screen.queryByRole('button', { name: /^clear$/i })).not.toBeInTheDocument();
    expect(screen.getByText('2 games')).toBeInTheDocument();
  });

  it('no longer renders a Source filter group, whose "Steam" collided with the "Steam / PC" platform chip', () => {
    render(
      <LibraryView
        games={[
          game({ id: 'a', platform: 'steam', steamAppid: 367520 }),
          game({ id: 'b', platform: 'ps5', steamAppid: null }),
        ]}
      />,
    );

    // The platform chip survives; the identically-named source chip does not.
    expect(screen.getByRole('button', { name: /^steam \/ pc/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^steam\d/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^manual/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^all sources/i })).not.toBeInTheDocument();
  });

  it('tells the owner the library is empty rather than rendering a blank grid', () => {
    render(<LibraryView games={[]} />);
    expect(screen.getByText(/no games yet/i)).toBeInTheDocument();
  });

  it('formats hours as the owner writes them, not as raw tenths', () => {
    render(<LibraryView games={[game({ hoursTenths: 1360 })]} />);
    expect(screen.getByText('136h')).toBeInTheDocument();
  });

  // Task 4 (PSN integration): a SEPARATE PlayStation sync button sits beside
  // the Steam one, disabled by default (the safe state) exactly like
  // `steamConfigured` defaults to `false` above.
  it('renders a separate, disabled-by-default PlayStation sync button beside the Steam one', () => {
    render(<LibraryView games={[]} />);

    expect(screen.getByRole('button', { name: /sync with steam/i })).toBeInTheDocument();
    const psnButton = screen.getByRole('button', { name: /sync with playstation/i });
    expect(psnButton).toBeInTheDocument();
    expect(psnButton).toBeDisabled();
  });

  it('enables the PlayStation sync button independently of the Steam one', () => {
    render(<LibraryView games={[]} steamConfigured={false} psnConfigured={true} />);

    expect(screen.getByRole('button', { name: /sync with steam/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /sync with playstation/i })).not.toBeDisabled();
  });

  /**
   * "Upcoming games" plan, Task 5: `wanted` (wishlist) rows are hidden from
   * the default view and revealed only by their own status chip — see
   * `library-view.tsx`'s `nonWantedGames` comment for the full reasoning.
   */
  describe('wanted (wishlist) games', () => {
    it('hides wanted games from the default gallery view', () => {
      render(
        <LibraryView
          games={[
            game({ id: 'a', title: 'Owned Game', status: 'completed' }),
            game({ id: 'b', title: 'Wishlisted Game', status: 'wanted' }),
          ]}
        />,
      );

      expect(screen.getByText('Owned Game')).toBeInTheDocument();
      expect(screen.queryByText('Wishlisted Game')).not.toBeInTheDocument();
    });

    it('reveals wanted games only once their own status chip is active', async () => {
      render(
        <LibraryView
          games={[
            game({ id: 'a', title: 'Owned Game', status: 'completed' }),
            game({ id: 'b', title: 'Wishlisted Game', status: 'wanted' }),
          ]}
        />,
      );

      await userEvent.click(screen.getByRole('button', { name: /^wanted/i }));

      expect(screen.getByText('Wishlisted Game')).toBeInTheDocument();
      expect(screen.queryByText('Owned Game')).not.toBeInTheDocument();
    });

    it('does not count wanted games in the platform chips or the header total', () => {
      render(
        <LibraryView
          games={[
            game({ id: 'a', title: 'Owned Game', status: 'completed', platform: 'ps5' }),
            game({ id: 'b', title: 'Wishlisted Game', status: 'wanted', platform: 'ps5' }),
          ]}
        />,
      );

      // "1 game" — the wishlist entry must not inflate the total.
      expect(screen.getByText('1 game')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^ps5/i })).toHaveTextContent('PS51');
    });

    it("the Wanted chip's own count is unaffected by being excluded from every other chip", () => {
      render(
        <LibraryView
          games={[
            game({ id: 'a', status: 'completed' }),
            game({ id: 'b', status: 'wanted' }),
            game({ id: 'c', status: 'wanted' }),
          ]}
        />,
      );

      expect(screen.getByRole('button', { name: /^wanted/i })).toHaveTextContent('Wanted2');
    });
  });
});
