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

vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { GameDialog } = await import('@/features/games/library/game-dialog');

type Game = NonNullable<Parameters<typeof GameDialog>[0]['game']>;

function wanted(overrides: Partial<Game> = {}): Game {
  return {
    id: 'w1',
    title: "Marvel's Wolverine",
    platform: 'ps5',
    developer: 'Insomniac Games',
    publisher: 'Sony Interactive Entertainment',
    ownership: 'digital',
    priceCents: null,
    status: 'wanted',
    rating: null,
    hoursTenths: null,
    firstPlayedYear: null,
    achievementsUnlocked: null,
    achievementsTotal: null,
    coverUrl: null,
    genre: 'Hack and slash, Adventure',
    notes: null,
    platinum: false,
    metacritic: 88,
    averagePlaytimeHours: 16,
    esrbRating: null,
    releaseDate: '2026-10-01',
    releasePrecision: 'day',
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

describe('GameDialog — create mode', () => {
  it('is titled Add game, defaults status to Played, and submits to createGameAction', async () => {
    const user = userEvent.setup();
    render(<GameDialog open onOpenChange={vi.fn()} />);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Add game' })).toBeInTheDocument();
    expect(within(dialog).getByText('Status')).toBeInTheDocument();
    // Radix Select renders the value in the trigger AND its hidden native select.
    expect(within(dialog).getAllByText('Played').length).toBeGreaterThan(0);

    await user.type(within(dialog).getByLabelText('Title'), 'Hades');
    await user.click(within(dialog).getByRole('button', { name: 'Add game' }));

    await waitFor(() => expect(createGameAction).toHaveBeenCalledTimes(1));
    expect(createGameAction.mock.calls[0]![0].get('status')).toBe('played');
    expect(completeWishlistGameAction).not.toHaveBeenCalled();
  });
});

describe('GameDialog — complete mode', () => {
  it('pre-fills title, platform and metadata from the wishlist row and hides the status control', () => {
    render(<GameDialog open onOpenChange={vi.fn()} mode="complete" game={wanted()} />);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Add to library' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Title')).toHaveValue("Marvel's Wolverine");
    expect(within(dialog).getAllByText('PS5').length).toBeGreaterThan(0);
    expect(within(dialog).getByText('Metacritic 88')).toBeInTheDocument();
    expect(within(dialog).queryByText('Status')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Add to library' })).toBeInTheDocument();
  });

  it('submits to completeWishlistGameAction with the row id, status played, and the metadata carried over', async () => {
    const user = userEvent.setup();
    render(<GameDialog open onOpenChange={vi.fn()} mode="complete" game={wanted()} />);

    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Hours played'), '16');
    await user.type(within(dialog).getByLabelText('Price paid'), '69.99');
    await user.click(within(dialog).getByRole('button', { name: 'Add to library' }));

    await waitFor(() => expect(completeWishlistGameAction).toHaveBeenCalledTimes(1));
    const [id, formData] = completeWishlistGameAction.mock.calls[0]!;
    expect(id).toBe('w1');
    expect(formData.get('status')).toBe('played');
    expect(formData.get('platform')).toBe('ps5');
    expect(formData.get('hours')).toBe('16');
    expect(formData.get('priceDollars')).toBe('69.99');
    expect(formData.get('genre')).toBe('Hack and slash, Adventure');
    expect(formData.get('metacritic')).toBe('88');
    expect(createGameAction).not.toHaveBeenCalled();
  });
});
