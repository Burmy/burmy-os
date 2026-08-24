import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GameSuggestion } from '@/server/games/metadata';

// Hoisted to a named const (not an inline `vi.fn()` inside the factory)
// specifically so this file can assert on its `.mock.calls` — the whole
// point of these tests is proving how many times, and with what argument,
// this action was invoked.
//
// The return type is annotated rather than inferred: bare `async () => []`
// infers `never[]`, which makes `mockResolvedValue([...])` a type error in
// the cover suite below.
const searchGameMetadataAction = vi.fn(async (_title: string): Promise<GameSuggestion[]> => []);

vi.mock('@/features/games/metadata-actions', () => ({
  searchGameMetadataAction,
}));

// Hoisted for the same reason as `searchGameMetadataAction` above: the cover
// regression below asserts on the FormData this actually received, which is
// only reachable through `.mock.calls`.
const updateGameAction = vi.fn(async (_id: string, _formData: FormData) => ({ ok: true as const }));

vi.mock('@/features/games/game-actions', () => ({
  deleteGameAction: vi.fn(async () => ({ ok: true as const })),
  createGameAction: vi.fn(async () => ({ ok: true as const })),
  updateGameAction,
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

/**
 * Regression coverage for "changing a game's cover art does nothing."
 *
 * `applySuggestion` guarded every metadata field on `field === ''`, grouping
 * `coverUrl` with `genre`/`developer`/`publisher`. That guard is right for
 * those three — each has a real text input, so a hand-typed value must not be
 * clobbered by a later pick. It was wrong for `coverUrl`, which has no input
 * control anywhere in the form: a pick is the only way it can ever change, so
 * guarding it on "still empty" made re-picking a cover on a game that already
 * had one a no-op that still reported "Game updated."
 */
describe('GameDialog cover art', () => {
  const OLD_COVER = 'https://images.igdb.com/igdb/image/upload/t_cover_big_2x/old.jpg';
  const NEW_COVER = 'https://images.igdb.com/igdb/image/upload/t_cover_big_2x/new.jpg';

  function suggestion(): GameSuggestion {
    return {
      externalId: 'igdb-1',
      title: 'Hades',
      coverUrl: NEW_COVER,
      genre: 'Roguelike',
      developer: 'Supergiant Games',
      publisher: 'Supergiant Games',
      metacritic: 93,
      averagePlaytimeHours: 22,
      esrbRating: 'T',
      releaseYear: 2020,
    };
  }

  beforeEach(() => {
    searchGameMetadataAction.mockClear();
    updateGameAction.mockClear();
  });

  async function pickTheSuggestion(existingCover: string | null): Promise<FormData> {
    searchGameMetadataAction.mockResolvedValue([suggestion()]);
    const user = userEvent.setup();
    render(<GameDialog game={game({ title: 'Hades', coverUrl: existingCover })} open onOpenChange={() => {}} />);

    // The search only fires once the owner actually edits the title (see the
    // `titleEditedRef` suite above), so retype it to surface the picker.
    const titleInput = screen.getByLabelText('Title');
    await user.clear(titleInput);
    await user.type(titleInput, 'Hades');

    const pick = await screen.findByRole('button', { name: /Hades \(2020\)/ }, { timeout: 2000 });
    await user.click(pick);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateGameAction).toHaveBeenCalledTimes(1);
    });
    return updateGameAction.mock.calls[0]![1];
  }

  it('submits the newly picked cover for a game that already had one', async () => {
    const formData = await pickTheSuggestion(OLD_COVER);
    expect(formData.get('coverUrl')).toBe(NEW_COVER);
  });

  it('still fills the cover for a game that had none', async () => {
    const formData = await pickTheSuggestion(null);
    expect(formData.get('coverUrl')).toBe(NEW_COVER);
  });

  it('leaves a hand-typed genre alone, unlike the cover', async () => {
    // The same pick that now always replaces cover art must NOT overwrite the
    // three fields the owner can actually type into.
    const formData = await pickTheSuggestion(OLD_COVER);
    expect(formData.get('coverUrl')).toBe(NEW_COVER);
    expect(formData.get('genre')).toBe('Action RPG');
  });
});
