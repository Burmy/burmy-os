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

// Hoisted for the same reason as `searchGameMetadataAction` above: the
// tests below assert on the FormData this actually received. `GameDialog`
// is create-only now — editing an existing game moved to `GamePage`
// (`tests/unit/games-game-page.test.tsx`), so only `createGameAction`
// needs mocking here.
const createGameAction = vi.fn(async (_formData: FormData) => ({ ok: true as const }));

vi.mock('@/features/games/game-actions', () => ({
  createGameAction,
}));

vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { GameDialog } = await import('@/features/games/library/game-dialog');

/**
 * Regression coverage for the "metadata lookup fires every time the dialog
 * opens" bug class. See `titleEditedRef` in `game-dialog.tsx` for the fix —
 * still relevant here even though the create-only dialog always starts with
 * an empty title (an existing-game variant of this same regression now
 * lives in `games-game-page.test.tsx`, since only `GamePage` ever seeds
 * `title` from real data on mount).
 */
describe('GameDialog metadata search', () => {
  beforeEach(() => {
    searchGameMetadataAction.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('makes zero metadata calls until the owner types a title', async () => {
    vi.useFakeTimers();
    render(<GameDialog open onOpenChange={() => {}} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(searchGameMetadataAction).not.toHaveBeenCalled();
  });

  it('calls the metadata action once the owner types a 3+ character title', async () => {
    const user = userEvent.setup();
    render(<GameDialog open onOpenChange={() => {}} />);

    await user.type(screen.getByLabelText('Title'), 'Bloodborne');

    await waitFor(
      () => {
        expect(searchGameMetadataAction).toHaveBeenCalledTimes(1);
      },
      { timeout: 2000 },
    );
    expect(searchGameMetadataAction).toHaveBeenCalledWith('Bloodborne');
  });
});

/**
 * Regression coverage for the Task 4 final-review Finding 1: the panel's
 * live validation and the dialog's own FormData serialization used to apply
 * TWO INDEPENDENT rules for which draft rows count, which disagreed in both
 * directions. See `.superpowers/sdd/2026-08-23-games-play-year-attribution/
 * task-4-report.md` for the fail-then-pass evidence recorded when
 * `isRealPlayYearDraft` was added. The data-loss half of this regression
 * (blanking a cell on an EXISTING stored split) only applies to editing —
 * that variant lives in `games-game-page.test.tsx` now.
 */
describe('GameDialog play-year split', () => {
  beforeEach(() => {
    searchGameMetadataAction.mockClear();
    createGameAction.mockClear();
  });

  it('submits a row whose year is still blank rather than silently dropping it (false-OK regression)', async () => {
    // Total 49h. Row 1 is fully filled (2024/37h). Row 2 is the owner typing
    // hours BEFORE year — hours '12', year still blank. The panel's live
    // check sums both rows' hours (37 + 12 = 49) and shows no warning. Before
    // the fix, the dialog separately dropped row 2 for having a blank year,
    // so what actually reached the server (only 2024/37 = 37 of 49) silently
    // disagreed with what the screen just showed matched exactly.
    const user = userEvent.setup();
    render(<GameDialog open onOpenChange={() => {}} />);

    await user.type(screen.getByLabelText('Title'), 'Hollow Knight');
    await user.click(screen.getByRole('tab', { name: 'Progress' }));
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

    await user.click(screen.getByRole('button', { name: 'Add game' }));

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
});

/**
 * The dialog is split into three tabs (Details / Progress / Notes) instead
 * of one long scrolling grid — progressive disclosure (hide/show behind a
 * "More details" toggle) was tried first and real usage still found it too
 * dense/scrolly. Tabs cap what's visible at once.
 *
 * `forceMount` on every `TabsContent`, not Radix's default (unmount the
 * inactive panel), is the same "never let a field go missing from the DOM
 * at submit time" rule the old disclosure toggle needed.
 */
describe('GameDialog — tabs', () => {
  it('defaults to the Progress tab, with Details and Notes present but inactive', () => {
    render(<GameDialog open onOpenChange={() => {}} />);

    expect(screen.getByRole('tab', { name: 'Progress' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'Notes' })).toHaveAttribute('aria-selected', 'false');

    // Status lives on Progress (the active tab) — visible immediately.
    expect(screen.getByLabelText('Status')).toBeInTheDocument();
  });

  it('switches tabs on click, without losing the other tabs\' fields from the DOM', async () => {
    const user = userEvent.setup();
    render(<GameDialog open onOpenChange={() => {}} />);

    // Genre lives on Details — present but inactive before switching.
    expect(screen.getByRole('button', { name: 'Genre' })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Details' }));
    expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Platform')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Notes' }));
    expect(screen.getByRole('tab', { name: 'Notes' })).toHaveAttribute('aria-selected', 'true');
    // `getByRole('textbox', ...)`, not `getByLabelText` — the Notes TAB
    // TRIGGER and the Notes FIELD's own `<label>` share the exact same
    // text, and the tabpanel's Radix-generated `aria-labelledby` (pointing
    // at the trigger) makes `getByLabelText('Notes')` ambiguous between the
    // two. Scoping by role sidesteps it: only the textarea has
    // `role="textbox"`, the trigger has `role="tab"`.
    expect(screen.getByRole('textbox', { name: 'Notes' })).toBeInTheDocument();

    // Switching away from Progress didn't unmount Status.
    expect(screen.getByLabelText('Status')).toBeInTheDocument();
  });

  it('keeps a typed field mounted, and submitted, after switching away from its tab', async () => {
    createGameAction.mockClear();
    const user = userEvent.setup();
    render(<GameDialog open onOpenChange={() => {}} />);

    await user.type(screen.getByLabelText('Title'), 'Hollow Knight');
    await user.click(screen.getByRole('tab', { name: 'Details' }));
    await user.click(screen.getByRole('button', { name: 'Genre' }));
    await user.type(screen.getByRole('textbox', { name: 'Genre' }), 'Metroidvania');
    await user.tab(); // blur, commits

    // Switch away from Details before saving — Genre's hidden input is no
    // longer on the active tab.
    await user.click(screen.getByRole('tab', { name: 'Notes' }));

    await user.click(screen.getByRole('button', { name: 'Add game' }));

    await waitFor(() => {
      expect(createGameAction).toHaveBeenCalledTimes(1);
    });
    const submitted = createGameAction.mock.calls[0]![0];
    // An unmount-based tab implementation would have dropped Genre from
    // FormData the moment its tab went inactive.
    expect(submitted.get('genre')).toBe('Metroidvania');
  });
});

/**
 * Genre/Developer/Publisher: plain text until clicked, then a real input —
 * see `InlineField`'s own doc comment in `field-controls.tsx` for why this
 * isn't Finance's `InlineEditText`. The hidden input is what actually
 * reaches `FormData`.
 */
describe('GameDialog — Genre/Developer/Publisher inline fields', () => {
  it('reveals a real input on click and commits the typed value on blur', async () => {
    const user = userEvent.setup();
    render(<GameDialog open onOpenChange={() => {}} />);
    await user.click(screen.getByRole('tab', { name: 'Details' }));

    expect(screen.queryByRole('textbox', { name: 'Genre' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Genre' }));
    const input = screen.getByRole('textbox', { name: 'Genre' });
    await user.type(input, 'Metroidvania');
    await user.tab(); // blur

    expect(screen.getByRole('button', { name: 'Genre' })).toHaveTextContent('Metroidvania');
  });

  /**
   * Regression: pressing Escape to cancel just THIS field's edit used to
   * bubble up and trigger Radix Dialog's own Escape-to-close handler,
   * closing the entire dialog instead of just reverting the one field.
   * Caught by a live browser check, not by any test before this one. Still
   * relevant to this create-only dialog specifically — it's still wrapped
   * in a real Radix `Dialog`, unlike the edit page's copy of this test.
   */
  it('pressing Escape cancels only the field edit, without closing the whole dialog', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<GameDialog open onOpenChange={onOpenChange} />);
    await user.click(screen.getByRole('tab', { name: 'Details' }));

    await user.click(screen.getByRole('button', { name: 'Genre' }));
    const input = screen.getByRole('textbox', { name: 'Genre' });
    await user.type(input, 'Something');
    await user.keyboard('{Escape}');

    expect(onOpenChange).not.toHaveBeenCalled();
    // Discarded, not committed — back to the empty placeholder state.
    expect(screen.queryByRole('textbox', { name: 'Genre' })).not.toBeInTheDocument();
  });

  it('submits the typed value', async () => {
    createGameAction.mockClear();
    const user = userEvent.setup();
    render(<GameDialog open onOpenChange={() => {}} />);
    await user.type(screen.getByLabelText('Title'), 'Hollow Knight');
    await user.click(screen.getByRole('tab', { name: 'Details' }));

    await user.click(screen.getByRole('button', { name: 'Genre' }));
    const input = screen.getByRole('textbox', { name: 'Genre' });
    await user.type(input, 'Metroidvania');
    await user.tab();

    await user.click(screen.getByRole('button', { name: 'Add game' }));

    await waitFor(() => {
      expect(createGameAction).toHaveBeenCalledTimes(1);
    });
    const submitted = createGameAction.mock.calls[0]![0];
    expect(submitted.get('genre')).toBe('Metroidvania');
  });
});
