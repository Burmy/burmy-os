import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GameTable } from '@/features/games/library/game-table';

type Game = Parameters<typeof GameTable>[0]['games'][number];

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
    playYears: [],
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
    render(<GameTable games={[game({ steamAppid: 367520 })]} onOpen={vi.fn()} />);
    expect(screen.getByText(/steam/i)).toBeInTheDocument();
  });

  it('shows no Steam mark for an unlinked game', () => {
    render(<GameTable games={[game({ steamAppid: null })]} onOpen={vi.fn()} />);
    expect(screen.queryByText(/steam/i)).not.toBeInTheDocument();
  });
});
