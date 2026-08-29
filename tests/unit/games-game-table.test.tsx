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
    steamAppid: null,
    psnTitleId: null,
    psnNpCommunicationId: null,
    lastPlayedAt: null,
    releaseDate: null,
    releasePrecision: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    playYears: [],
    collectionId: null,
    ...overrides,
  };
}

/**
 * Task 5 follow-up: the source mark landed on `game-card.tsx` (gallery view)
 * but not `game-table.tsx`, so an owner working in table view got no
 * provenance signal at all — half an answer to "can u differentiate somehow
 * what games are from the api and what are not?" Folded into the existing
 * Platform cell, same as the card folds it into its own platform/year line,
 * rather than a new column.
 */
describe('GameTable Steam provenance', () => {
  it('shows a Steam mark for a linked game', () => {
    render(<GameTable openingId={null} groups={[solo({ steamAppid: 367520 })]} onOpen={vi.fn()} />);
    expect(screen.getByText(/steam/i)).toBeInTheDocument();
  });

  it('shows no Steam mark for an unlinked game', () => {
    render(<GameTable openingId={null} groups={[solo({ steamAppid: null })]} onOpen={vi.fn()} />);
    expect(screen.queryByText(/steam/i)).not.toBeInTheDocument();
  });
});

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
    render(<GameTable openingId={null} groups={[{ game: collection, members }]} onOpen={vi.fn()} />);
    expect(screen.getByText('3 games')).toBeInTheDocument();
  });

  it('renders every title inside the collection as its own row', () => {
    render(<GameTable openingId={null} groups={[{ game: collection, members }]} onOpen={vi.fn()} />);
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
    render(<GameTable openingId={null} groups={[{ game: collection, members }]} onOpen={onOpen} />);

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
    render(<GameTable openingId={null} groups={[solo()]} onOpen={vi.fn()} />);
    expect(screen.queryByText(/\d+ games?$/)).not.toBeInTheDocument();
  });
});

/**
 * Clicking a cover or a row starts a cross-segment navigation with a database
 * read at the other end, and nothing on screen used to acknowledge it — in a
 * wall of near-identical tiles that reads as a missed click, so the owner
 * clicks again. `openingId` is the acknowledgement.
 */
describe('GameTable open feedback', () => {
  it('marks only the row being opened as busy', () => {
    const collection = game({ id: 'ndc', title: 'Nathan Drake Collection' });
    const members = [game({ id: 'uc1', title: 'Drake 1', collectionId: 'ndc' })];

    render(
      <GameTable
        openingId="uc1"
        groups={[{ game: collection, members }]}
        onOpen={vi.fn()}
      />,
    );

    const busy = screen.getAllByRole('row').filter((row) => row.getAttribute('aria-busy') === 'true');
    expect(busy).toHaveLength(1);
    expect(busy[0]?.textContent).toContain('Drake 1');
  });

  it('marks the COLLECTION row busy when it is the one being opened', () => {
    // The wrapper row and the nested rows are wired separately, so a test that
    // only ever opens a member leaves half the wiring unproven — verified by
    // mutation: breaking the collection row's own binding kept that test green.
    const collection = game({ id: 'ndc', title: 'Nathan Drake Collection' });
    const members = [game({ id: 'uc1', title: 'Drake 1', collectionId: 'ndc' })];

    render(
      <GameTable openingId="ndc" groups={[{ game: collection, members }]} onOpen={vi.fn()} />,
    );

    const busy = screen.getAllByRole('row').filter((row) => row.getAttribute('aria-busy') === 'true');
    expect(busy).toHaveLength(1);
    expect(busy[0]?.textContent).toContain('Nathan Drake Collection');
  });

  it('marks nothing busy when no navigation is in flight', () => {
    render(<GameTable openingId={null} groups={[solo()]} onOpen={vi.fn()} />);
    expect(screen.queryByRole('row', { busy: true })).not.toBeInTheDocument();
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
    render(<GameTable openingId={null} groups={[solo()]} onOpen={vi.fn()} />);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('offers a checkbox for the collection and for each member', () => {
    render(
      <GameTable
        openingId={null}
        groups={[{ game: collection, members }]}
        onOpen={vi.fn()}
        selectedIds={[]}
        onToggleSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole('checkbox', { name: 'Select Nathan Drake Collection' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select Drake 1' })).toBeInTheDocument();
  });

  it('reflects which rows are already selected', () => {
    render(
      <GameTable
        openingId={null}
        groups={[{ game: collection, members }]}
        onOpen={vi.fn()}
        selectedIds={['uc1']}
        onToggleSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole('checkbox', { name: 'Select Drake 1' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select Nathan Drake Collection' })).not.toBeChecked();
  });

  it('toggles rather than navigating when the row is clicked in selection mode', async () => {
    const onOpen = vi.fn();
    const onToggleSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <GameTable
        openingId={null}
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
        openingId={null}
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
        openingId={null}
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
