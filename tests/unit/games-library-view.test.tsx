import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const deleteGameAction = vi.fn(async () => ({ ok: true as const }));
const createGameAction = vi.fn(async () => ({ ok: true as const }));
const updateGameAction = vi.fn(async () => ({ ok: true as const }));

vi.mock('@/features/games/game-actions', () => ({
  deleteGameAction,
  createGameAction,
  updateGameAction,
}));

vi.mock('@/features/games/metadata-actions', () => ({
  searchGameMetadataAction: vi.fn(async () => []),
}));

vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// The header renders `SyncButton` (Task 6) unconditionally now, which calls
// `useRouter()` even when its own click handler is never exercised — these
// tests don't render inside a real Next.js app router, so it needs a mock
// like every other `next/navigation` usage in this suite.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const { LibraryView } = await import('@/features/games/library/library-view');

type Game = Parameters<typeof LibraryView>[0]['games'][number];

function game(overrides: Partial<Game>): Game {
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
    psnTitleId: null,
    psnNpCommunicationId: null,
    lastPlayedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    playYears: [],
    ...overrides,
  };
}

describe('LibraryView', () => {
  it('renders every game in the default gallery view', () => {
    render(<LibraryView games={[game({ id: 'a', title: 'Elden Ring' }), game({ id: 'b', title: 'Prey' })]} />);

    expect(screen.getByText('Elden Ring')).toBeInTheDocument();
    expect(screen.getByText('Prey')).toBeInTheDocument();
  });

  it('switches to a table view without losing any games', async () => {
    render(<LibraryView games={[game({ id: 'a', title: 'Elden Ring' })]} />);

    await userEvent.click(screen.getByRole('button', { name: /table view/i }));

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('Elden Ring')).toBeInTheDocument();
  });

  it('opens the editor from the table view by keyboard, not just by clicking the row', async () => {
    render(<LibraryView games={[game({ id: 'a', title: 'Elden Ring' })]} />);

    await userEvent.click(screen.getByRole('button', { name: /table view/i }));

    // The row itself is not a focusable control — a real button inside the
    // title cell is, so this is what tab order actually lands on.
    screen.getByRole('button', { name: 'Elden Ring' }).focus();
    await userEvent.keyboard('{Enter}');

    expect(screen.getByRole('heading', { name: 'Elden Ring', level: 2 })).toBeInTheDocument();
  });

  it('filters by status', async () => {
    render(
      <LibraryView
        games={[
          game({ id: 'a', title: 'Finished Game', status: 'completed' }),
          game({ id: 'b', title: 'Queued Game', status: 'backlog' }),
        ]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /^backlog/i }));

    expect(screen.getByText('Queued Game')).toBeInTheDocument();
    expect(screen.queryByText('Finished Game')).not.toBeInTheDocument();
  });

  it('filters by platform', async () => {
    render(
      <LibraryView
        games={[
          game({ id: 'a', title: 'Console Game', platform: 'ps5' }),
          game({ id: 'b', title: 'Desktop Game', platform: 'steam' }),
        ]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /^steam/i }));

    expect(screen.getByText('Desktop Game')).toBeInTheDocument();
    expect(screen.queryByText('Console Game')).not.toBeInTheDocument();
  });

  it('combines status and platform filters', async () => {
    render(
      <LibraryView
        games={[
          game({ id: 'a', title: 'Match', status: 'completed', platform: 'steam' }),
          game({ id: 'b', title: 'Wrong status', status: 'backlog', platform: 'steam' }),
          game({ id: 'c', title: 'Wrong platform', status: 'completed', platform: 'ps5' }),
        ]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /^completed/i }));
    await userEvent.click(screen.getByRole('button', { name: /^steam/i }));

    expect(screen.getByText('Match')).toBeInTheDocument();
    expect(screen.queryByText('Wrong status')).not.toBeInTheDocument();
    expect(screen.queryByText('Wrong platform')).not.toBeInTheDocument();
  });

  it('shows a searchable count that reflects the active filter', async () => {
    render(
      <LibraryView
        games={[
          game({ id: 'a', title: 'Finished Game', status: 'completed' }),
          game({ id: 'b', title: 'Queued Game', status: 'backlog' }),
        ]}
      />,
    );

    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'Queued');

    expect(screen.getByText('Queued Game')).toBeInTheDocument();
    expect(screen.queryByText('Finished Game')).not.toBeInTheDocument();
  });

  it('does not render a platform filter chip for a platform with zero games', () => {
    render(<LibraryView games={[game({ id: 'a', platform: 'ps5' })]} />);

    expect(screen.getByRole('button', { name: /^all platforms/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^ps5/i })).toBeInTheDocument();
    // steam, psp, pc, other all have zero games in this library — none of
    // their chips should exist at all, not just be inactive.
    expect(screen.queryByRole('button', { name: /^steam/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^psp/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^pc/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^other/i })).not.toBeInTheDocument();
  });

  it('does not render a status filter chip for a status with zero games', () => {
    render(<LibraryView games={[game({ id: 'a', status: 'completed' })]} />);

    // `\d` right after "all" (no space) is what makes this the STATUS
    // group's own "All" chip specifically — "All platforms"/"All sources"
    // both also start with "all" but with a space, not a digit, so this
    // stays unambiguous as more "All ___" chip groups are added.
    expect(screen.getByRole('button', { name: /^all\d/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^completed/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^backlog/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^playing/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^paused/i })).not.toBeInTheDocument();
  });

  it('labels the steam platform chip "Steam / PC"', () => {
    render(<LibraryView games={[game({ id: 'a', platform: 'steam' })]} />);
    expect(screen.getByRole('button', { name: /^steam \/ pc/i })).toBeInTheDocument();
  });

  /**
   * Task 5: the Source facet distinguishes "Steam owns this game's hours"
   * from "the owner entered it by hand" — `steamAppid !== null`, not the
   * `platform` field (see the matching provenance note on `game-card.tsx`
   * and `game-dialog.tsx`'s `steamOwned`).
   */
  it('filters by source', async () => {
    render(
      <LibraryView
        games={[
          game({ id: 'a', title: 'Linked Game', steamAppid: 367520 }),
          game({ id: 'b', title: 'Hand-entered Game', steamAppid: null }),
        ]}
      />,
    );

    // `\d` right after "steam" (no space, see the "All" chip's own comment
    // above) picks the Source chip specifically, not the platform group's
    // "Steam / PC" — neither game here uses the `steam` platform, so that
    // chip wouldn't render anyway, but the digit anchor keeps this correct
    // even in a library that has both.
    await userEvent.click(screen.getByRole('button', { name: /^steam\d/i }));

    expect(screen.getByText('Linked Game')).toBeInTheDocument();
    expect(screen.queryByText('Hand-entered Game')).not.toBeInTheDocument();
  });

  it('does not render a source filter chip when every game shares one source', () => {
    render(<LibraryView games={[game({ id: 'a', steamAppid: null })]} />);

    expect(screen.getByRole('button', { name: /^all sources/i })).toBeInTheDocument();
    // Every game here is manual — the "Steam" chip would be a dead 0 count.
    expect(screen.queryByRole('button', { name: /^steam\d/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^manual/i })).toBeInTheDocument();
  });

  it('tells the owner the library is empty rather than rendering a blank grid', () => {
    render(<LibraryView games={[]} />);
    expect(screen.getByText(/no games yet/i)).toBeInTheDocument();
  });

  it('formats hours as the owner writes them, not as raw tenths', () => {
    render(<LibraryView games={[game({ hoursTenths: 1360 })]} />);
    expect(screen.getByText('136h')).toBeInTheDocument();
  });
});
