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
   * Platinum and wishlist used to be told apart by SILHOUETTE (a
   * rounded-square medallion vs. a circle) because both were colored
   * badges painted on box art. That whole approach is gone — real usage
   * rejected app-colored chrome sitting on third-party cover art. Both
   * glyphs are now the same quiet monochrome circle, and the two states
   * are distinguished by the ICON inside and by the card's own treatment
   * instead. This guards that: a platinum card carries the badge AND the
   * metallic ring, which is what a wishlist card never has.
   */
  it('marks platinum with both a cover badge and the card-level metallic ring', () => {
    render(<GameCard game={game({ platinum: true })} onOpen={vi.fn()} />);

    expect(screen.getByTitle('Platinum')).toBeInTheDocument();
    expect(screen.getByRole('button').className).toMatch(/ring-slate-400/);
  });

  it('never shows both the platinum and wishlist badges on one card', () => {
    // `wanted` + `platinum` is nonsensical data, but the card renders from
    // whatever the row holds — platinum wins, and only one glyph is drawn.
    render(<GameCard game={game({ platinum: true, status: 'wanted' })} onOpen={vi.fn()} />);

    expect(screen.getByTitle('Platinum')).toBeInTheDocument();
    expect(screen.queryByTitle('On your wishlist')).not.toBeInTheDocument();
  });
});

/**
 * The card went cover-first: real usage found it carried eight competing
 * things at once and read as "too compact, way too much happening." Only
 * the cover, the title and ONE metadata line (platform + hours) survive.
 * These guard that the dropped fields stay dropped — each is still on the
 * game's own page, this is only about what the GRID advertises.
 */
describe('GameCard — cover-first content', () => {
  it('shows the title and a single platform + hours metadata line', () => {
    render(<GameCard game={game({ title: 'Bloodborne', platform: 'ps4', hoursTenths: 1360 })} onOpen={vi.fn()} />);

    expect(screen.getByText('Bloodborne')).toBeInTheDocument();
    expect(screen.getByText('PS4 · 136h')).toBeInTheDocument();
  });

  it('omits hours entirely rather than printing a fabricated zero', () => {
    render(<GameCard game={game({ platform: 'ps4', hoursTenths: null })} onOpen={vi.fn()} />);

    expect(screen.getByText('PS4')).toBeInTheDocument();
    expect(screen.queryByText(/0h/)).not.toBeInTheDocument();
  });

  it('no longer renders the year, the Steam provenance tag, or a star rating', () => {
    render(
      <GameCard
        game={game({ firstPlayedYear: 2022, steamAppid: 367520, rating: 5, platform: 'steam' })}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.queryByText(/2022/)).not.toBeInTheDocument();
    // The platform LABEL is "Steam / PC"; what's gone is the separate
    // "· Steam" provenance tag that used to follow the year.
    expect(screen.queryByText(/· Steam$/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/out of 5/)).not.toBeInTheDocument();
  });

  it('keeps status in the accessible name even though no status badge renders', () => {
    render(<GameCard game={game({ title: 'Bloodborne', status: 'backlog' })} onOpen={vi.fn()} />);

    // The visible badge is gone, so this is now the ONLY status signal a
    // screen-reader user tabbing the grid gets.
    expect(screen.getByRole('button', { name: 'Bloodborne — Backlog' })).toBeInTheDocument();
  });
});
