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
    // `getByRole('textbox', ...)`, not `getByLabelText` — the Notes TAB
    // TRIGGER and the Notes FIELD's own `<label>` share the exact same
    // text, and the tabpanel's Radix-generated `aria-labelledby` (pointing
    // at the trigger) makes `getByLabelText('Notes')` ambiguous between the
    // two. Scoping by role sidesteps it: only the textarea has
    // `role="textbox"`, the trigger has `role="tab"`.
    expect(screen.getByRole('textbox', { name: 'Notes' })).not.toBeDisabled();
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

/**
 * The dialog is split into three tabs (Details / Progress / Notes) instead
 * of one long scrolling grid — progressive disclosure (hide/show behind a
 * "More details" toggle) was tried first and real usage still found an
 * already-filled-out game too dense/scrolly, since it opened expanded by
 * design. Tabs cap what's visible at once regardless of how much data a
 * game already has.
 *
 * `forceMount` on every `TabsContent`, not Radix's default (unmount the
 * inactive panel), is the same "never let a field go missing from the DOM
 * at submit time" rule the old disclosure toggle needed — these tests
 * assert every field is still present, still submitted, on whichever tab
 * ISN'T currently showing.
 */
describe('GameDialog — tabs', () => {
  it('defaults to the Progress tab, with Details and Notes present but inactive', () => {
    render(<GameDialog game={game()} open onOpenChange={() => {}} />);

    expect(screen.getByRole('tab', { name: 'Progress' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'Notes' })).toHaveAttribute('aria-selected', 'false');

    // Status lives on Progress (the active tab) — visible immediately.
    expect(screen.getByLabelText('Status')).toBeInTheDocument();
  });

  it('switches tabs on click, without losing the other tabs\' fields from the DOM', async () => {
    const user = userEvent.setup();
    render(<GameDialog game={game()} open onOpenChange={() => {}} />);

    // Genre lives on Details — present but inactive before switching.
    const genreButtonBefore = screen.getByRole('button', { name: 'Genre' });
    expect(genreButtonBefore).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Details' }));
    expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Platform')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Notes' }));
    expect(screen.getByRole('tab', { name: 'Notes' })).toHaveAttribute('aria-selected', 'true');
    // `getByRole('textbox', ...)`, not `getByLabelText` — see the Steam
    // provenance suite above for why the two are ambiguous here.
    expect(screen.getByRole('textbox', { name: 'Notes' })).toBeInTheDocument();

    // Switching away from Progress didn't unmount Status.
    expect(screen.getByLabelText('Status')).toBeInTheDocument();
  });

  it('submits fields from every tab, not just whichever one is currently active', async () => {
    updateGameAction.mockClear();
    const user = userEvent.setup();
    // Default tab is Progress — Genre/Developer/Publisher (Details) and
    // Notes (Notes tab) are never clicked into before Save.
    render(<GameDialog game={game({ genre: 'Action RPG', notes: 'Great game' })} open onOpenChange={() => {}} />);

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateGameAction).toHaveBeenCalledTimes(1);
    });
    const submitted = updateGameAction.mock.calls[0]![1];
    // Present with their real values, not merely present — an unmount-based
    // tab implementation would have dropped these keys from FormData
    // entirely, which `parse()` in game-actions.ts reads as "explicitly
    // cleared."
    expect(submitted.get('genre')).toBe('Action RPG');
    expect(submitted.get('notes')).toBe('Great game');
  });
});

/**
 * Genre/Developer/Publisher: plain text until clicked, then a real input —
 * see `InlineField`'s own doc comment in game-dialog.tsx for why this isn't
 * Finance's `InlineEditText`. The hidden input is what actually reaches
 * `FormData`; these tests cover both the read state and the edit-then-blur
 * commit path.
 */
describe('GameDialog — Genre/Developer/Publisher inline fields', () => {
  it('shows the current value as plain text, not an input, until clicked', async () => {
    const user = userEvent.setup();
    render(<GameDialog game={game({ genre: 'Roguelike' })} open onOpenChange={() => {}} />);
    await user.click(screen.getByRole('tab', { name: 'Details' }));

    expect(screen.getByRole('button', { name: 'Genre' })).toHaveTextContent('Roguelike');
    expect(screen.queryByRole('textbox', { name: 'Genre' })).not.toBeInTheDocument();
  });

  it('reveals a real input on click and commits the typed value on blur', async () => {
    const user = userEvent.setup();
    render(<GameDialog game={game({ genre: 'Roguelike' })} open onOpenChange={() => {}} />);
    await user.click(screen.getByRole('tab', { name: 'Details' }));

    await user.click(screen.getByRole('button', { name: 'Genre' }));
    const input = screen.getByRole('textbox', { name: 'Genre' });
    await user.clear(input);
    await user.type(input, 'Metroidvania');
    await user.tab(); // blur

    expect(screen.getByRole('button', { name: 'Genre' })).toHaveTextContent('Metroidvania');
  });

  /**
   * Regression: pressing Escape to cancel just THIS field's edit used to
   * bubble up and trigger Radix Dialog's own Escape-to-close handler,
   * closing the entire dialog instead of just reverting the one field.
   * Caught by a live browser check, not by any test before this one.
   */
  it('pressing Escape cancels only the field edit, without closing the whole dialog', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<GameDialog game={game({ genre: 'Roguelike' })} open onOpenChange={onOpenChange} />);
    await user.click(screen.getByRole('tab', { name: 'Details' }));

    await user.click(screen.getByRole('button', { name: 'Genre' }));
    const input = screen.getByRole('textbox', { name: 'Genre' });
    await user.clear(input);
    await user.type(input, 'Something else');
    await user.keyboard('{Escape}');

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Genre' })).toHaveTextContent('Roguelike');
  });

  it('submits the edited value, not the original', async () => {
    updateGameAction.mockClear();
    const user = userEvent.setup();
    render(<GameDialog game={game({ genre: 'Roguelike' })} open onOpenChange={() => {}} />);
    await user.click(screen.getByRole('tab', { name: 'Details' }));

    await user.click(screen.getByRole('button', { name: 'Genre' }));
    const input = screen.getByRole('textbox', { name: 'Genre' });
    await user.clear(input);
    await user.type(input, 'Metroidvania');
    await user.tab();

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateGameAction).toHaveBeenCalledTimes(1);
    });
    const submitted = updateGameAction.mock.calls[0]![1];
    expect(submitted.get('genre')).toBe('Metroidvania');
  });
});
