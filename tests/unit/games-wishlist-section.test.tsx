import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ActionResult } from '@/features/games/action-result';

const updateGameFieldAction = vi.fn(
  async (_id: string, _field: string, _value: string): Promise<ActionResult> => ({ ok: true }),
);
vi.mock('@/features/games/game-actions', () => ({
  updateGameFieldAction: (...args: [string, string, string]) => updateGameFieldAction(...args),
}));

const openGame = vi.fn();
vi.mock('@/features/games/panel/game-panel-context', () => ({
  useGamePanel: () => ({ openGame, close: vi.fn(), activeId: null }),
}));

vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { WishlistSection } = await import('@/features/games/upcoming/wishlist-section');

type Game = Parameters<typeof WishlistSection>[0]['games'][number];

/** 6 September 2026, the same instant `games-release-date.test.ts` pins. */
const NOW = new Date('2026-09-06T12:00:00.000Z');

function wanted(overrides: Partial<Game> = {}): Game {
  return {
    id: 'w1',
    title: 'Hollow Knight: Silksong',
    platform: 'steam',
    developer: null,
    publisher: null,
    ownership: null,
    priceCents: null,
    status: 'wanted',
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
    collectionId: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('WishlistSection — order and release state', () => {
  it('lists released games first with an "Out now" mark, then dated, then undated', () => {
    render(
      <WishlistSection
        now={NOW}
        games={[
          wanted({ id: 'a', title: 'No Date Yet' }),
          wanted({
            id: 'b',
            title: 'Coming Soon',
            releaseDate: '2026-10-02',
            releasePrecision: 'day',
          }),
          wanted({
            id: 'c',
            title: 'Already Out',
            releaseDate: '2026-05-05',
            releasePrecision: 'day',
          }),
        ]}
      />,
    );

    const titles = screen
      .getAllByRole('button', { name: /^(No Date Yet|Coming Soon|Already Out)$/ })
      .map((b) => b.textContent);
    expect(titles[0]).toContain('Already Out');
    expect(titles[1]).toContain('Coming Soon');
    expect(titles[2]).toContain('No Date Yet');
    expect(screen.getAllByText('Out now')).toHaveLength(1);
    expect(screen.getByText(/in 26 days/)).toBeInTheDocument();
    expect(screen.getByText(/No date/)).toBeInTheDocument();
  });

  it('counts the wishlist in the heading and shows an empty line when there is nothing', () => {
    const { rerender } = render(<WishlistSection now={NOW} games={[]} />);
    expect(screen.getByText('0 games')).toBeInTheDocument();
    expect(screen.getByText(/Nothing on your wishlist yet/)).toBeInTheDocument();

    rerender(<WishlistSection now={NOW} games={[wanted()]} />);
    expect(screen.getByText('1 game')).toBeInTheDocument();
  });
});

describe('WishlistSection — actions', () => {
  it('opens the game panel with the full row when the title is clicked', async () => {
    const user = userEvent.setup();
    const game = wanted();
    render(<WishlistSection now={NOW} games={[game]} />);

    await user.click(screen.getByRole('button', { name: 'Hollow Knight: Silksong' }));

    expect(openGame).toHaveBeenCalledWith(game);
  });

  it('marks a game as played from the quick menu through the status field action', async () => {
    const user = userEvent.setup();
    render(<WishlistSection now={NOW} games={[wanted({ id: 'w1' })]} />);

    await user.click(screen.getByRole('button', { name: 'Mark Hollow Knight: Silksong as' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Played' }));

    await waitFor(() =>
      expect(updateGameFieldAction).toHaveBeenCalledWith('w1', 'status', 'played'),
    );
  });

  it('offers exactly Played — never Wanted, which is where it already is', async () => {
    const user = userEvent.setup();
    render(<WishlistSection now={NOW} games={[wanted()]} />);

    await user.click(screen.getByRole('button', { name: 'Mark Hollow Knight: Silksong as' }));

    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(items).toEqual(['Played']);
  });

  it('shows an error toast and re-enables the menu when the action rejects', async () => {
    updateGameFieldAction.mockRejectedValueOnce(new Error('boom'));
    const { toast } = await import('@/components/ui/toast');
    const user = userEvent.setup();
    render(<WishlistSection now={NOW} games={[wanted()]} />);

    await user.click(screen.getByRole('button', { name: 'Mark Hollow Knight: Silksong as' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Played' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Mark Hollow Knight: Silksong as' }),
      ).not.toBeDisabled(),
    );
  });
});
