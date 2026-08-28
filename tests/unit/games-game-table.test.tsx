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
    render(<GameTable groups={[solo({ steamAppid: 367520 })]} onOpen={vi.fn()} />);
    expect(screen.getByText(/steam/i)).toBeInTheDocument();
  });

  it('shows no Steam mark for an unlinked game', () => {
    render(<GameTable groups={[solo({ steamAppid: null })]} onOpen={vi.fn()} />);
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
    render(<GameTable groups={[{ game: collection, members }]} onOpen={vi.fn()} />);
    expect(screen.getByText('3 games')).toBeInTheDocument();
  });

  it('renders every title inside the collection as its own row', () => {
    render(<GameTable groups={[{ game: collection, members }]} onOpen={vi.fn()} />);
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
    render(<GameTable groups={[{ game: collection, members }]} onOpen={onOpen} />);

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
    render(<GameTable groups={[solo()]} onOpen={vi.fn()} />);
    expect(screen.queryByText(/\d+ games?$/)).not.toBeInTheDocument();
  });
});
