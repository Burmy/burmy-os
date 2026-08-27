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
    releaseDate: null,
    releasePrecision: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    playYears: [],
    ...overrides,
  };
}

/** The foil layer's tone, or `null` for an ordinary card. See `foil-card.tsx`. */
function foilTone(): string | null {
  return document.querySelector('.foil-card')?.getAttribute('data-foil') ?? null;
}

/**
 * `played` (the invisible default status) renders no `StatusBadge` at all, so
 * for most of the real library the card's own treatment is the ONLY signal a
 * game is platinumed.
 *
 * That treatment has now changed twice — a colored badge on the art, then a
 * metallic ring plus a raised fill — and these tests changed with it each time,
 * which is the smell that they were asserting the wrong thing. They now assert
 * the STABLE fact: the card declares which foil it wants via `data-foil`, and
 * what that resolves to visually is `globals.css`'s business.
 */
describe('GameCard — platinum treatment', () => {
  it('declares the platinum foil, which a plain card does not', () => {
    render(<GameCard game={game({ platinum: true })} onOpen={vi.fn()} />);

    expect(foilTone()).toBe('platinum');
  });

  it('declares no foil at all for a plain game', () => {
    render(<GameCard game={game({ platinum: false })} onOpen={vi.fn()} />);

    expect(foilTone()).toBeNull();
  });

  /**
   * Platinum and wishlist used to be told apart by SILHOUETTE (a
   * rounded-square medallion vs. a circle) because both were colored badges
   * painted on box art. That approach is gone — real usage rejected
   * app-colored chrome sitting on third-party cover art. Both glyphs are now
   * the same quiet monochrome circle, and the two states are distinguished by
   * the ICON inside plus the card's own foil.
   */
  it('marks platinum with both a cover glyph and the platinum foil', () => {
    render(<GameCard game={game({ platinum: true })} onOpen={vi.fn()} />);

    expect(document.querySelector('.lucide-trophy')).toBeInTheDocument();
    expect(foilTone()).toBe('platinum');
  });

  it('never shows both the platinum and wishlist glyphs on one card', () => {
    // `wanted` + `platinum` is nonsensical data, but the card renders from
    // whatever the row holds — platinum wins, and only one glyph is drawn.
    render(<GameCard game={game({ platinum: true, status: 'wanted' })} onOpen={vi.fn()} />);

    expect(document.querySelector('.lucide-trophy')).toBeInTheDocument();
    expect(document.querySelector('.lucide-heart')).not.toBeInTheDocument();
    expect(foilTone()).toBe('platinum');
  });

  it('gives a wishlist game the frost foil, not the platinum one', () => {
    render(<GameCard game={game({ status: 'wanted' })} onOpen={vi.fn()} />);

    expect(foilTone()).toBe('wishlist');
  });
});

/**
 * The card has been cut down twice — first to cover + title + one metadata
 * line, then to the cover alone. Real usage asked for "just the cards," so the
 * gallery is now a wall of box art with NO visible text whatsoever, not even
 * on hover; reading a title is what Table view is for.
 *
 * That makes `aria-label` load-bearing rather than supplementary, which is
 * what these tests exist to protect.
 */
describe('GameCard — cover-only content', () => {
  it('renders no visible text at all', () => {
    const { container } = render(
      <GameCard
        game={game({ title: 'Bloodborne', platform: 'ps4', hoursTenths: 1360, coverUrl: 'https://x/c.jpg' })}
        onOpen={vi.fn()}
      />,
    );

    expect(container.textContent).toBe('');
    expect(screen.queryByText('Bloodborne')).not.toBeInTheDocument();
    expect(screen.queryByText(/136h/)).not.toBeInTheDocument();
    expect(screen.queryByText(/PS4/)).not.toBeInTheDocument();
  });

  /**
   * The one exception, and it is decorative: a game with no cover art falls
   * back to a letter tile, so a single initial is rendered. It is `aria-hidden`
   * — the accessible name still comes from the button's own label.
   */
  it('falls back to an aria-hidden initial when there is no cover art', () => {
    render(<GameCard game={game({ title: 'Bloodborne', coverUrl: null })} onOpen={vi.fn()} />);

    const initial = screen.getByText('B');
    expect(initial).toBeInTheDocument();
    expect(initial.closest('[aria-hidden]')).not.toBeNull();
  });

  it('carries the title and status in the accessible name, the only place they exist', () => {
    render(<GameCard game={game({ title: 'Bloodborne', status: 'backlog' })} onOpen={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Bloodborne — Backlog' })).toBeInTheDocument();
  });

  /**
   * A native tooltip is the only recovery path a sighted owner has for box art
   * they don't recognise, now that nothing else on the card names the game.
   */
  it('exposes the title as a native tooltip', () => {
    render(<GameCard game={game({ title: 'Bloodborne' })} onOpen={vi.fn()} />);

    expect(screen.getByRole('button')).toHaveAttribute('title', 'Bloodborne');
  });
});
