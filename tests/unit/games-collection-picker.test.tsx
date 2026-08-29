import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { GamePickerDialog } from '@/features/games/collections/game-picker-dialog';

/**
 * The searchable picker that replaced the "Part of" `<select>`.
 *
 * The reason it exists is the reason these tests are mostly about SEARCH: a
 * library of 179 games makes an unfiltered option list unusable, and the
 * owner's own library has "Uncharted" in seven different titles, so matching
 * has to be forgiving about case and about the curly apostrophe a spreadsheet
 * inserts — otherwise a game that is right there reads as absent.
 */

const GAMES = [
  { id: 'ndc', title: 'Uncharted™: The Nathan Drake Collection', subtitle: 'PS4' },
  { id: 'uc1', title: "Uncharted: Drake’s Fortune Remastered", subtitle: 'PS4' },
  { id: 'lot', title: 'Uncharted: Legacy of Thieves Collection', subtitle: 'PS4' },
  { id: 'elden', title: 'Elden Ring', subtitle: 'PS5' },
];

function list(): HTMLElement {
  return screen.getByRole('list');
}

describe('GamePickerDialog — search', () => {
  it('lists every game before anything is typed', () => {
    render(<GamePickerDialog open onOpenChange={vi.fn()} title="Pick" games={GAMES} onConfirm={vi.fn()} />);
    expect(within(list()).getAllByRole('button')).toHaveLength(4);
  });

  it('filters to matches as you type, ignoring case', async () => {
    const user = userEvent.setup();
    render(<GamePickerDialog open onOpenChange={vi.fn()} title="Pick" games={GAMES} onConfirm={vi.fn()} />);

    await user.type(screen.getByRole('textbox', { name: 'Search games' }), 'UNCHARTED');
    expect(within(list()).getAllByRole('button')).toHaveLength(3);
    expect(screen.queryByText('Elden Ring')).not.toBeInTheDocument();
  });

  it("matches a curly apostrophe against a typed straight one", async () => {
    // The exact shape of the owner's data: the spreadsheet wrote `Drake’s`
    // and nobody types U+2019. Without the fold, searching "drake's" returns
    // nothing and the game looks missing.
    const user = userEvent.setup();
    render(<GamePickerDialog open onOpenChange={vi.fn()} title="Pick" games={GAMES} onConfirm={vi.fn()} />);

    await user.type(screen.getByRole('textbox', { name: 'Search games' }), "drake's fortune");
    expect(within(list()).getAllByRole('button')).toHaveLength(1);
  });

  it('says so plainly when nothing matches', async () => {
    const user = userEvent.setup();
    render(
      <GamePickerDialog
        open
        onOpenChange={vi.fn()}
        title="Pick"
        games={GAMES}
        emptyMessage="No collection matches that search."
        onConfirm={vi.fn()}
      />,
    );

    await user.type(screen.getByRole('textbox', { name: 'Search games' }), 'zzzz');
    expect(screen.getByText('No collection matches that search.')).toBeInTheDocument();
  });

  it('shows a subtitle so two similar titles can be told apart', () => {
    render(<GamePickerDialog open onOpenChange={vi.fn()} title="Pick" games={GAMES} onConfirm={vi.fn()} />);
    expect(screen.getAllByText('PS4')).toHaveLength(3);
  });
});

describe('GamePickerDialog — single select', () => {
  it('commits on click, with no second confirm step', async () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <GamePickerDialog open onOpenChange={onOpenChange} title="Pick" games={GAMES} onConfirm={onConfirm} />,
    );

    await user.click(screen.getByRole('button', { name: 'Elden Ring — PS5' }));

    expect(onConfirm).toHaveBeenCalledWith(['elden']);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('offers no confirm button at all in single mode', () => {
    render(<GamePickerDialog open onOpenChange={vi.fn()} title="Pick" games={GAMES} onConfirm={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
  });
});

describe('GamePickerDialog — multi select', () => {
  it('accumulates a selection and reports the count', async () => {
    const user = userEvent.setup();
    render(
      <GamePickerDialog open multiple onOpenChange={vi.fn()} title="Pick" games={GAMES} onConfirm={vi.fn()} />,
    );

    await user.click(screen.getByRole('button', { name: 'Elden Ring — PS5' }));
    await user.click(screen.getByRole('button', { name: 'Uncharted: Legacy of Thieves Collection — PS4' }));

    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });

  it('confirms the whole selection at once', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <GamePickerDialog
        open
        multiple
        onOpenChange={vi.fn()}
        title="Pick"
        games={GAMES}
        confirmLabel="Add to collection"
        onConfirm={onConfirm}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Elden Ring — PS5' }));
    await user.click(screen.getByRole('button', { name: 'Add to collection' }));

    expect(onConfirm).toHaveBeenCalledWith(['elden']);
  });

  it('toggles a chosen game back off', async () => {
    const user = userEvent.setup();
    render(
      <GamePickerDialog open multiple onOpenChange={vi.fn()} title="Pick" games={GAMES} onConfirm={vi.fn()} />,
    );

    const row = screen.getByRole('button', { name: 'Elden Ring — PS5' });
    await user.click(row);
    expect(row).toHaveAttribute('aria-pressed', 'true');
    await user.click(row);
    expect(row).toHaveAttribute('aria-pressed', 'false');
  });

  it('renders already-selected games as checked rather than hiding them', () => {
    // Current members stay in the list so the picker shows what the set
    // already contains; hiding them would make the dialog contradict the
    // panel it opened from.
    render(
      <GamePickerDialog
        open
        multiple
        onOpenChange={vi.fn()}
        title="Pick"
        games={GAMES}
        selectedIds={['uc1']}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Drake’s Fortune/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('cannot confirm an empty selection', () => {
    render(
      <GamePickerDialog open multiple onOpenChange={vi.fn()} title="Pick" games={GAMES} onConfirm={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
  });

  it('survives a caller that rebuilds selectedIds on every render', () => {
    // REGRESSION. The resync-during-render pattern compares the incoming prop
    // to a tracked previous value; every caller of this dialog builds that
    // array inline (`[collection.id]`, `members.map(…)`, or the `= []`
    // default), so a REFERENCE comparison is always unequal and React throws
    // "Too many re-renders". Comparing by value is what makes this safe.
    const { rerender } = render(
      <GamePickerDialog open multiple onOpenChange={vi.fn()} title="Pick" games={GAMES} selectedIds={['uc1']} onConfirm={vi.fn()} />,
    );

    for (let i = 0; i < 3; i += 1) {
      rerender(
        <GamePickerDialog open multiple onOpenChange={vi.fn()} title="Pick" games={GAMES} selectedIds={['uc1']} onConfirm={vi.fn()} />,
      );
    }

    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });
});
