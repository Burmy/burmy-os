import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { GameTable } from '@/features/games/library/game-table';

type Game = Parameters<typeof GameTable>[0]['groups'][number]['game'];

/** A standalone game — one top-level row, nothing filed under it. */
function solo(overrides: Partial<Game> = {}) {
  return { game: game(overrides), members: [] };
}

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

/**
 * Collections nest one level, the way the source spreadsheet drew them. The
 * indent is CSS, so it proves nothing on its own — these assert the two
 * things a reader (or a screen reader) actually gets: the wrapper says how
 * many titles it holds, and each nested row names its parent.
 */
describe('GameTable collections', () => {
  const collection = game({ id: 'ndc', title: 'Uncharted: The Nathan Drake Collection' });
  const members = [
    game({ id: 'uc1', title: "Uncharted: Drake's Fortune Remastered", collectionId: 'ndc' }),
    game({ id: 'uc2', title: 'Uncharted 2: Among Thieves Remastered', collectionId: 'ndc' }),
    game({ id: 'uc3', title: "Uncharted 3: Drake's Deception Remastered", collectionId: 'ndc' }),
  ];

  it('marks the collection row with its title count', () => {
    render(<GameTable activeId={null} groups={[{ game: collection, members }]} onOpen={vi.fn()} />);
    expect(screen.getByText('3 games')).toBeInTheDocument();
  });

  it('renders every title inside the collection as its own row', () => {
    render(<GameTable activeId={null} groups={[{ game: collection, members }]} onOpen={vi.fn()} />);
    for (const member of members) {
      expect(
        screen.getByRole('button', {
          name: `${member.title} — in Uncharted: The Nathan Drake Collection`,
        }),
      ).toBeInTheDocument();
    }
  });

  it('opens the member, not the collection, when a nested title is activated', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<GameTable activeId={null} groups={[{ game: collection, members }]} onOpen={onOpen} />);

    await user.click(
      screen.getByRole('button', {
        name: "Uncharted: Drake's Fortune Remastered — in Uncharted: The Nathan Drake Collection",
      }),
    );

    // Once, not twice: the row's own `onClick` must not also fire. The nested
    // row sits inside the same `<tr>`-click convenience as every other row.
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'uc1' }));
  });

  it('shows no count marker on a standalone game', () => {
    render(<GameTable activeId={null} groups={[solo()]} onOpen={vi.fn()} />);
    expect(screen.queryByText(/\d+ games?$/)).not.toBeInTheDocument();
  });
});

/**
 * The side panel opens BESIDE the table, so the row it is showing is
 * highlighted — the table's equivalent of the ring on a gallery card.
 * Both the wrapper row and the nested rows are wired separately, so each
 * gets its own case (verified by mutation on the old spinner wiring:
 * breaking the collection row's binding kept a member-only test green).
 */
describe('GameTable active row', () => {
  function activeRows(): HTMLElement[] {
    return screen.getAllByRole('row').filter((row) => row.hasAttribute('data-active'));
  }

  it('highlights only the row the panel is showing', () => {
    const collection = game({ id: 'ndc', title: 'Nathan Drake Collection' });
    const members = [game({ id: 'uc1', title: 'Drake 1', collectionId: 'ndc' })];

    render(<GameTable activeId="uc1" groups={[{ game: collection, members }]} onOpen={vi.fn()} />);

    expect(activeRows()).toHaveLength(1);
    expect(activeRows()[0]?.textContent).toContain('Drake 1');
  });

  it('highlights the COLLECTION row when it is the one open', () => {
    const collection = game({ id: 'ndc', title: 'Nathan Drake Collection' });
    const members = [game({ id: 'uc1', title: 'Drake 1', collectionId: 'ndc' })];

    render(<GameTable activeId="ndc" groups={[{ game: collection, members }]} onOpen={vi.fn()} />);

    expect(activeRows()).toHaveLength(1);
    expect(activeRows()[0]?.textContent).toContain('Nathan Drake Collection');
  });

  it('highlights nothing while the panel is closed', () => {
    render(<GameTable activeId={null} groups={[solo()]} onOpen={vi.fn()} />);
    expect(activeRows()).toHaveLength(0);
  });
});

/**
 * Selection mode, used by the library's "Add to collection" bulk bar.
 *
 * The rule worth pinning is that selecting and OPENING are different intents
 * on the same row: in selection mode the row toggles, but the title link
 * still navigates — otherwise turning the mode on would leave no way to reach
 * a game's page from the table at all.
 */
describe('GameTable selection', () => {
  const collection = game({ id: 'ndc', title: 'Nathan Drake Collection' });
  const members = [game({ id: 'uc1', title: 'Drake 1', collectionId: 'ndc' })];

  it('renders no checkbox column at all unless selection is wired up', () => {
    render(<GameTable activeId={null} groups={[solo()]} onOpen={vi.fn()} />);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('offers a checkbox for the collection and for each member', () => {
    render(
      <GameTable
        activeId={null}
        groups={[{ game: collection, members }]}
        onOpen={vi.fn()}
        selectedIds={[]}
        onToggleSelect={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('checkbox', { name: 'Select Nathan Drake Collection' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select Drake 1' })).toBeInTheDocument();
  });

  it('reflects which rows are already selected', () => {
    render(
      <GameTable
        activeId={null}
        groups={[{ game: collection, members }]}
        onOpen={vi.fn()}
        selectedIds={['uc1']}
        onToggleSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole('checkbox', { name: 'Select Drake 1' })).toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: 'Select Nathan Drake Collection' }),
    ).not.toBeChecked();
  });

  it('toggles rather than navigating when the row is clicked in selection mode', async () => {
    const onOpen = vi.fn();
    const onToggleSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <GameTable
        activeId={null}
        groups={[solo()]}
        onOpen={onOpen}
        selectedIds={[]}
        onToggleSelect={onToggleSelect}
      />,
    );

    await user.click(screen.getByRole('row', { name: /Elden Ring/ }));

    expect(onToggleSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'game-1' }));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('still opens the game from the title link while selecting', async () => {
    // Without this, switching on selection mode strands the owner: every row
    // toggles and nothing reaches a game's page.
    const onOpen = vi.fn();
    const onToggleSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <GameTable
        activeId={null}
        groups={[solo()]}
        onOpen={onOpen}
        selectedIds={[]}
        onToggleSelect={onToggleSelect}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Elden Ring' }));

    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'game-1' }));
    expect(onToggleSelect).not.toHaveBeenCalled();
  });

  it('toggles from the checkbox without also firing the row', async () => {
    const onOpen = vi.fn();
    const onToggleSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <GameTable
        activeId={null}
        groups={[solo()]}
        onOpen={onOpen}
        selectedIds={[]}
        onToggleSelect={onToggleSelect}
      />,
    );

    await user.click(screen.getByRole('checkbox', { name: 'Select Elden Ring' }));

    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('GameTable totals', () => {
  it('shows base + DLC hours and trophies in the row', () => {
    render(
      <GameTable
        activeId={null}
        groups={[
          solo({
            dlc: [
              {
                id: 'dlc-1',
                gameId: 'game-1',
                name: 'Shadow of the Erdtree',
                year: 2025,
                hoursTenths: 60,
                priceCents: 3999,
                achievementsUnlocked: 10,
                achievementsTotal: 12,
              },
            ],
          }),
        ]}
        onOpen={vi.fn()}
      />,
    );
    const row = screen.getByRole('button', { name: 'Elden Ring' }).closest('tr');
    expect(row).toHaveTextContent('142h');
    expect(row).toHaveTextContent('52 / 54');
  });
});

describe('GameTable columns', () => {
  it('has no Status column — played is invisible and wanted has its own chip', () => {
    render(<GameTable activeId={null} groups={[solo()]} onOpen={vi.fn()} />);
    expect(screen.queryByRole('columnheader', { name: 'Status' })).not.toBeInTheDocument();
  });
});

/**
 * Hours (and trophies) roll up onto the collection's row from the titles
 * inside it, the same figure the panel shows — see `rollUpHours`. A set whose
 * members carry nothing still shows its own unsplit lump.
 */
describe('GameTable collection roll-ups', () => {
  it('shows the members’ summed hours on the collection row and each member’s own on its row', () => {
    const collection = game({
      id: 'trilogy',
      title: 'Crysis Remastered Trilogy',
      hoursTenths: 320,
    });
    const members = [
      game({ id: 'c1', title: 'Crysis Remastered', collectionId: 'trilogy', hoursTenths: 97 }),
      game({ id: 'c2', title: 'Crysis 2 Remastered', collectionId: 'trilogy', hoursTenths: 133 }),
      game({ id: 'c3', title: 'Crysis 3 Remastered', collectionId: 'trilogy', hoursTenths: 102 }),
    ];
    render(<GameTable activeId={null} groups={[{ game: collection, members }]} onOpen={vi.fn()} />);

    // 9.7 + 13.3 + 10.2 — the wrapper's own 32.0 is superseded, never added.
    expect(screen.getByText('33.2h')).toBeInTheDocument();
    expect(screen.queryByText('32h')).not.toBeInTheDocument();
    expect(screen.getByText('9.7h')).toBeInTheDocument();
    expect(screen.getByText('13.3h')).toBeInTheDocument();
  });

  it('keeps an unsplit collection’s own hours while no member carries any', () => {
    const collection = game({ id: 'ndc', title: 'Nathan Drake Collection', hoursTenths: 442 });
    const members = [
      game({ id: 'uc1', title: 'Drake 1', collectionId: 'ndc', hoursTenths: null }),
      game({ id: 'uc2', title: 'Drake 2', collectionId: 'ndc', hoursTenths: null }),
    ];
    render(<GameTable activeId={null} groups={[{ game: collection, members }]} onOpen={vi.fn()} />);

    expect(screen.getByText('44.2h')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});

describe('GameTable collection rating', () => {
  it('shows no stars on the collection row; the games inside keep theirs (2026-10-19)', () => {
    const collection = game({ id: 'ndc', title: 'Nathan Drake Collection', rating: 2 });
    const members = [game({ id: 'uc1', title: 'Drake 1', collectionId: 'ndc', rating: 5 })];
    render(<GameTable activeId={null} groups={[{ game: collection, members }]} onOpen={vi.fn()} />);

    expect(screen.queryByLabelText('2 out of 5')).not.toBeInTheDocument();
    expect(screen.getByLabelText('5 out of 5')).toBeInTheDocument();
  });
});
