import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted to a named const (not an inline `vi.fn()` inside the factory)
// specifically so this file can assert on its `.mock.calls` — the whole
// point of these tests is proving how many times, and with what argument,
// this action was invoked.
const searchGameMetadataAction = vi.fn(async () => []);

vi.mock('@/features/games/metadata-actions', () => ({
  searchGameMetadataAction,
}));

vi.mock('@/features/games/game-actions', () => ({
  deleteGameAction: vi.fn(async () => ({ ok: true as const })),
  createGameAction: vi.fn(async () => ({ ok: true as const })),
  updateGameAction: vi.fn(async () => ({ ok: true as const })),
}));

vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { GameDialog } = await import('@/features/games/library/game-dialog');

type GameDialogProps = Parameters<typeof GameDialog>[0];
type Game = NonNullable<GameDialogProps['game']>;

function game(overrides: Partial<Game> = {}): Game {
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
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

/**
 * Regression coverage for the "metadata lookup fires every time an existing
 * game is opened" bug. Opening an existing game seeds the title field from
 * `game.title`, which is almost always >= the 3-character search minimum —
 * the debounced search effect used to key off `title` alone and fire on
 * mount for a game that already has all its metadata, hitting IGDB for
 * nothing on every single card click. See `titleEditedRef` in
 * `game-dialog.tsx` for the fix.
 */
describe('GameDialog metadata search', () => {
  // `vi.fn()` created outside a `vi.mock` factory's own scope (necessary
  // here so its call history is assertable at all — see the comment above)
  // is NOT reset by the global `restoreMocks: true` config: per Vitest's own
  // docs, `mockRestore()` "has no effect if the mock was not created with
  // vi.spyOn," and `restoreMocks` calls exactly that. Without this explicit
  // clear, a call recorded in one test leaks into the next test's assertion.
  beforeEach(() => {
    searchGameMetadataAction.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('makes zero metadata calls just from opening an existing game', async () => {
    vi.useFakeTimers();
    render(<GameDialog game={game({ title: 'Elden Ring' })} open onOpenChange={() => {}} />);

    // Comfortably past the 300ms debounce — if the old bug were back, the
    // call would already have fired well before this.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(searchGameMetadataAction).not.toHaveBeenCalled();
  });

  it('calls the metadata action once the owner actually edits the title field', async () => {
    // Real timers here, not fake ones — `userEvent.clear`/`.type` combined
    // with fake timers deadlocked (5s timeout, no error) rather than
    // resolving, so this test waits out the real 300ms debounce instead.
    const user = userEvent.setup();
    render(<GameDialog game={game({ title: 'Elden Ring' })} open onOpenChange={() => {}} />);

    const titleInput = screen.getByLabelText('Title');
    await user.clear(titleInput);
    await user.type(titleInput, 'Bloodborne');

    await waitFor(
      () => {
        expect(searchGameMetadataAction).toHaveBeenCalledTimes(1);
      },
      { timeout: 2000 },
    );
    expect(searchGameMetadataAction).toHaveBeenCalledWith('Bloodborne');
  });

  it('makes zero metadata calls when adding a new game until the owner types a title', async () => {
    vi.useFakeTimers();
    render(<GameDialog game={null} open onOpenChange={() => {}} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(searchGameMetadataAction).not.toHaveBeenCalled();
  });
});
