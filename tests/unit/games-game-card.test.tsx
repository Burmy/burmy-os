import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GameCard } from '@/features/games/library/game-card';
import type { Game } from '@/server/db/games/games';

function game(overrides: Partial<Game> = {}): Game {
  return {
    id: 'g1',
    title: 'Bloodborne',
    platform: 'ps4',
    developer: null,
    publisher: null,
    ownership: null,
    priceCents: null,
    status: 'played',
    rating: null,
    hoursTenths: null,
    firstPlayedYear: null,
    achievementsUnlocked: null,
    achievementsTotal: null,
    coverUrl: null,
    genre: null,
    notes: null,
    platinum: false,
    metacritic: null,
    averagePlaytimeHours: null,
    esrbRating: null,
    steamAppid: null,
    psnTitleId: null,
    psnNpCommunicationId: null,
    lastPlayedAt: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    playYears: [],
    ...overrides,
  };
}

/**
 * `played` (the invisible default status) intentionally renders no
 * `StatusBadge` at all — see that component's own doc comment — so for most
 * of the real library, this card-level ring is the ONLY visible signal that
 * a game is platinumed. These tests assert the card itself, not just
 * `PlatinumBadge`, carries a distinguishing treatment.
 */
describe('GameCard — platinum treatment', () => {
  it('gives a platinum game a distinct ring/border the plain card does not have', () => {
    render(<GameCard game={game({ platinum: true })} onOpen={vi.fn()} />);

    const card = screen.getByRole('button');
    expect(card.className).toMatch(/ring-slate-400/);
  });

  it('does not add the platinum ring/border to a non-platinum game', () => {
    render(<GameCard game={game({ platinum: false })} onOpen={vi.fn()} />);

    const card = screen.getByRole('button');
    expect(card.className).not.toMatch(/ring-slate-400/);
  });

  /**
   * Real usage found the previous circular platinum badge hard to tell
   * apart from the (also circular) wishlist badge on the Upcoming tab —
   * see `platinum-badge.tsx`'s own doc comment. It moved to a rounded-square
   * medallion for a distinct silhouette; this guards that shape decision.
   */
  it('renders the platinum badge as a rounded-square medallion, not a circle', () => {
    render(<GameCard game={game({ platinum: true })} onOpen={vi.fn()} />);

    const badge = screen.getByTitle('Platinum');
    expect(badge.className).toMatch(/\brounded-lg\b/);
    expect(badge.className).not.toMatch(/rounded-full/);
  });
});
