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

// Also hoisted (not an inline `vi.fn()`), for the same reason as
// `updateGameAction` above: the play-year regression tests below assert on
// the FormData this actually received.
const createGameAction = vi.fn(async (_formData: FormData) => ({ ok: true as const }));

vi.mock('@/features/games/game-actions', () => ({
  deleteGameAction: vi.fn(async () => ({ ok: true as const })),
  createGameAction,
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
    status: 'played',
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

/**
 * Regression coverage for the Task 4 final-review Finding 1: the panel's
 * live validation and the dialog's own FormData serialization used to apply
 * TWO INDEPENDENT rules for which draft rows count, which disagreed in both
 * directions. Both suites below reproduce the exact scenarios from the
 * review before the shared `isRealPlayYearDraft` rule existed — see
 * `.superpowers/sdd/2026-08-23-games-play-year-attribution/task-4-report.md`
 * for the fail-then-pass evidence recorded when these were added.
 */
describe('GameDialog play-year split — row-eligibility consistency', () => {
  beforeEach(() => {
    searchGameMetadataAction.mockClear();
    createGameAction.mockClear();
    updateGameAction.mockClear();
  });

  it('submits a row whose year is still blank rather than silently dropping it (false-OK regression)', async () => {
    // Total 49h. Row 1 is fully filled (2024/37h). Row 2 is the owner typing
    // hours BEFORE year — hours '12', year still blank. The panel's live
    // check sums both rows' hours (37 + 12 = 49) and shows no warning. Before
    // the fix, the dialog separately dropped row 2 for having a blank year,
    // so what actually reached the server (only 2024/37 = 37 of 49) silently
    // disagreed with what the screen just showed matched exactly.
    const user = userEvent.setup();
    render(<GameDialog game={null} open onOpenChange={() => {}} />);

    await user.type(screen.getByLabelText('Title'), 'Hollow Knight');
    await user.type(screen.getByLabelText('Hours played'), '49');
    await user.click(screen.getByRole('button', { name: /split across years/i }));

    await user.click(screen.getByRole('button', { name: /add a year/i }));
    await user.type(screen.getAllByLabelText('Year')[0]!, '2024');
    await user.type(screen.getAllByLabelText('Hours')[0]!, '37');

    await user.click(screen.getByRole('button', { name: /add a year/i }));
    // Only hours typed on the second row — its year stays blank.
    await user.type(screen.getAllByLabelText('Hours')[1]!, '12');

    // The live panel shows no mismatch: 37 + 12 = 49, matching the total.
    expect(screen.queryByRole('alert')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(createGameAction).toHaveBeenCalledTimes(1);
    });
    const submitted = createGameAction.mock.calls[0]![0];
    const submittedPlayYears = JSON.parse(submitted.get('playYears') as string) as unknown[];

    // Whatever the panel used to compute "49h of 49h" must be exactly what
    // reaches the server. Dropping the blank-year row here means the server
    // sees only 37 of 49 — a mismatch the screen never warned about.
    expect(submittedPlayYears).toHaveLength(2);
  });

  it('does not silently empty an existing stored split when only the year cell is blanked (data-loss regression)', async () => {
    // A game with a real stored split: 2024 -> 49h, matching the 49h total
    // exactly. The owner blanks the YEAR cell only — the hours cell still
    // reads '49'. Before the fix, the dialog's submit-time filter dropped
    // any row with a blank year, so this row vanished from the FormData
    // entirely: `playYears` became `[]`, which `validateSplit` treats as
    // legitimately "no split" (ok: true), and `replacePlayYears(..., [])`
    // then DELETES the stored split outright — a successful-looking save
    // that destroys real data.
    const user = userEvent.setup();
    const existing = game({
      hoursTenths: 490,
      playYears: [{ year: 2024, hoursTenths: 490 }],
    });
    render(<GameDialog game={existing} open onOpenChange={() => {}} />);

    // The split panel starts expanded because this game already has a split.
    const yearInput = screen.getByLabelText('Year');
    await user.clear(yearInput);

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateGameAction).toHaveBeenCalledTimes(1);
    });
    const submitted = updateGameAction.mock.calls[0]![1];
    const submittedPlayYears = JSON.parse(submitted.get('playYears') as string) as unknown[];

    // A row that still carries real hours data must never be indistinguishable
    // from "delete this row" just because its year cell was cleared.
    expect(submittedPlayYears.length).toBeGreaterThan(0);
  });
});

/**
 * Task 5: for a game linked to a Steam app, Steam owns its hours and
 * achievement counts, so those fields render read-only and say where the
 * number came from — this is the UI half of the fix for "I am confused what
 * is from Steam and what is from my manual entry." The server-side half
 * (a disabled input is a UI affordance, not a security boundary) lives in
 * `tests/integration/games-actions.test.ts`.
 */
describe('GameDialog Steam provenance', () => {
  it('renders hours read-only for a Steam-linked game', () => {
    render(<GameDialog game={game({ steamAppid: 367520 })} open onOpenChange={() => {}} />);
    expect(screen.getByLabelText('Hours played')).toBeDisabled();
  });

  it('labels the field with its source', () => {
    render(<GameDialog game={game({ steamAppid: 367520 })} open onOpenChange={() => {}} />);
    // One "From Steam" note each for Hours, Achievements earned and
    // Achievements total — see the "keeps achievement counts read-only"
    // test below for the disabled assertion on those same three fields.
    expect(screen.getAllByText(/from steam/i).length).toBeGreaterThan(0);
  });

  it('keeps hours editable for a game with no Steam link', () => {
    render(<GameDialog game={game({ steamAppid: null })} open onOpenChange={() => {}} />);
    expect(screen.getByLabelText('Hours played')).not.toBeDisabled();
  });

  it('keeps achievement counts read-only for a Steam-linked game', () => {
    render(<GameDialog game={game({ steamAppid: 367520 })} open onOpenChange={() => {}} />);
    expect(screen.getByLabelText('Achievements earned')).toBeDisabled();
    expect(screen.getByLabelText('Achievements total')).toBeDisabled();
  });

  it('keeps rating, status and notes editable for a Steam-linked game', () => {
    render(<GameDialog game={game({ steamAppid: 367520 })} open onOpenChange={() => {}} />);
    expect(screen.getByLabelText('Rating (1-5)')).not.toBeDisabled();
    // `status` is a Radix `Select` — its accessible control is the trigger
    // button (`role="combobox"`), labelled via FieldSelect's `htmlFor`.
    expect(screen.getByLabelText('Status')).not.toBeDisabled();
    expect(screen.getByLabelText('Notes')).not.toBeDisabled();
  });

  it('keeps the play-year split editable even when the total is Steam-owned', () => {
    // Steam knows the total; only the owner knows which year it happened in.
    render(
      <GameDialog
        game={game({ steamAppid: 367520, hoursTenths: 490, playYears: [{ year: 2024, hoursTenths: 490 }] })}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByLabelText('Year')).not.toBeDisabled();
  });
});
