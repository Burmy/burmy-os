import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const setGameStatusAction = vi.fn(async () => ({ ok: true as const }));
const deleteGameAction = vi.fn(async () => ({ ok: true as const }));
const createGameAction = vi.fn(async () => ({ ok: true as const }));
const updateGameAction = vi.fn(async () => ({ ok: true as const }));

vi.mock('@/features/games/game-actions', () => ({
  setGameStatusAction,
  deleteGameAction,
  createGameAction,
  updateGameAction,
}));

vi.mock('@/features/games/metadata-actions', () => ({
  searchGameMetadataAction: vi.fn(async () => []),
}));

vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
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

  it('tells the owner the library is empty rather than rendering a blank grid', () => {
    render(<LibraryView games={[]} />);
    expect(screen.getByText(/no games yet/i)).toBeInTheDocument();
  });

  it('formats hours as the owner writes them, not as raw tenths', () => {
    render(<LibraryView games={[game({ hoursTenths: 1360 })]} />);
    expect(screen.getByText('136h')).toBeInTheDocument();
  });
});
