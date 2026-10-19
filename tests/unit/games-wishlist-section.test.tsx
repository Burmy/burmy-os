import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ActionResult } from '@/features/games/action-result';
import type { GameSuggestion } from '@/server/games/metadata';

const completeWishlistGameAction = vi.fn(
  async (_id: string, _formData: FormData): Promise<ActionResult> => ({ ok: true }),
);
const createGameAction = vi.fn(async (_formData: FormData): Promise<ActionResult> => ({
  ok: true,
}));
vi.mock('@/features/games/game-actions', () => ({
  completeWishlistGameAction: (...args: [string, FormData]) => completeWishlistGameAction(...args),
  createGameAction: (...args: [FormData]) => createGameAction(...args),
}));

const searchGameMetadataAction = vi.fn(async (_title: string): Promise<GameSuggestion[]> => []);
vi.mock('@/features/games/metadata-actions', () => ({
  searchGameMetadataAction: (...args: [string]) => searchGameMetadataAction(...args),
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
    dlc: [],
    collectionId: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('WishlistSection — cards, order and release state', () => {
  it('renders one cover card per game: released first with an "Out now" pill, then dated, then undated', () => {
    const { container } = render(
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

    const cards = [...container.querySelectorAll<HTMLElement>('[data-slot="wishlist-card"]')];
    expect(cards).toHaveLength(3);
    const covers = screen.getAllByRole('button', {
      name: /^(No Date Yet|Coming Soon|Already Out)$/,
    });
    expect(covers.map((cover) => cover.getAttribute('aria-label'))).toEqual([
      'Already Out',
      'Coming Soon',
      'No Date Yet',
    ]);
    // The on-art pill, once; the release line under the cover says it again.
    expect(within(cards[0]!).getByText('Out now')).toBeInTheDocument();
    expect(within(cards[0]!).getByText('Steam / PC · Out now')).toBeInTheDocument();
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
  it('opens the game panel with the full row when the cover is clicked', async () => {
    const user = userEvent.setup();
    const game = wanted();
    render(<WishlistSection now={NOW} games={[game]} />);

    await user.click(screen.getByRole('button', { name: 'Hollow Knight: Silksong' }));

    expect(openGame).toHaveBeenCalledWith(game);
  });

  it('"Mark as played" opens the add dialog pre-filled, without a status control', async () => {
    const user = userEvent.setup();
    render(
      <WishlistSection now={NOW} games={[wanted({ platform: 'ps5', genre: 'Metroidvania' })]} />,
    );

    await user.click(
      screen.getByRole('button', { name: 'Mark Hollow Knight: Silksong as played' }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Add to library' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Hollow Knight: Silksong');
    expect(within(dialog).queryByText('Status')).not.toBeInTheDocument();
    // Pre-filled from the row, so no search fires for a title the owner never typed.
    expect(searchGameMetadataAction).not.toHaveBeenCalled();
  });

  it('submits the pre-filled dialog to completeWishlistGameAction with status played', async () => {
    const user = userEvent.setup();
    render(<WishlistSection now={NOW} games={[wanted({ id: 'w1' })]} />);

    await user.click(
      screen.getByRole('button', { name: 'Mark Hollow Knight: Silksong as played' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Hours played'), '16');
    await user.click(within(dialog).getByRole('button', { name: 'Add to library' }));

    await waitFor(() => expect(completeWishlistGameAction).toHaveBeenCalledTimes(1));
    const [id, formData] = completeWishlistGameAction.mock.calls[0]!;
    expect(id).toBe('w1');
    expect(formData.get('title')).toBe('Hollow Knight: Silksong');
    expect(formData.get('hours')).toBe('16');
    expect(formData.get('status')).toBe('played');
    expect(createGameAction).not.toHaveBeenCalled();
  });

  it('shows the action’s error inside the dialog and keeps it open', async () => {
    completeWishlistGameAction.mockResolvedValueOnce({ ok: false, error: 'boom' });
    const user = userEvent.setup();
    render(<WishlistSection now={NOW} games={[wanted()]} />);

    await user.click(
      screen.getByRole('button', { name: 'Mark Hollow Knight: Silksong as played' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Add to library' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('boom');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closing the dialog changes nothing', async () => {
    const user = userEvent.setup();
    render(<WishlistSection now={NOW} games={[wanted()]} />);

    await user.click(
      screen.getByRole('button', { name: 'Mark Hollow Knight: Silksong as played' }),
    );
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(completeWishlistGameAction).not.toHaveBeenCalled();
  });
});
