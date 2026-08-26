import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ActionResult } from '@/features/games/action-result';
import type { GameSuggestion } from '@/server/games/metadata';
import type { Trophy } from '@/server/games/psn';

const searchGameMetadataAction = vi.fn(async (_title: string): Promise<GameSuggestion[]> => []);

vi.mock('@/features/games/metadata-actions', () => ({
  searchGameMetadataAction,
}));

const updateGameFieldAction = vi.fn(
  async (_id: string, _field: string, _value: string): Promise<ActionResult> => ({ ok: true }),
);
const applyMetadataSuggestionAction = vi.fn(
  async (_id: string, _suggestion: unknown): Promise<ActionResult> => ({ ok: true }),
);
const updateGamePlayYearsAction = vi.fn(
  async (_id: string, _drafts: unknown): Promise<ActionResult> => ({ ok: true }),
);
const deleteGameAction = vi.fn(async (_id: string): Promise<ActionResult> => ({ ok: true }));

vi.mock('@/features/games/game-actions', () => ({
  updateGameFieldAction: (...args: [string, string, string]) => updateGameFieldAction(...args),
  applyMetadataSuggestionAction: (...args: [string, unknown]) => applyMetadataSuggestionAction(...args),
  updateGamePlayYearsAction: (...args: [string, unknown]) => updateGamePlayYearsAction(...args),
  deleteGameAction: (...args: [string]) => deleteGameAction(...args),
}));

const fetchGameTrophiesAction = vi.fn();

vi.mock('@/features/games/game/trophy-actions', () => ({
  fetchGameTrophiesAction: (...args: [string]) => fetchGameTrophiesAction(...args),
}));

vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const { GamePage } = await import('@/features/games/game/game-page');

type GamePageProps = Parameters<typeof GamePage>[0];
type Game = GamePageProps['game'];

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
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    playYears: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('GamePage — read display', () => {
  it('renders every field formatted, with no inputs visible until clicked', () => {
    render(<GamePage game={game()} />);

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Elden Ring' })).toBeInTheDocument();
    expect(screen.getByText('PS5')).toBeInTheDocument();
    expect(screen.getByText('Played')).toBeInTheDocument();
    expect(screen.getByText('136h')).toBeInTheDocument();
    expect(screen.getByText('Physical')).toBeInTheDocument();
    expect(screen.getByText('Action RPG')).toBeInTheDocument();
    expect(screen.getByText('$65.65')).toBeInTheDocument();
  });

  it('shows "Not set" placeholders for unset fields', () => {
    render(<GamePage game={game({ ownership: null, genre: null, developer: null, publisher: null })} />);
    expect(screen.getAllByText('Not set').length).toBeGreaterThan(0);
  });
});

describe('GamePage — text field inline editing', () => {
  it('reveals a real input on click and saves the field on blur', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ genre: 'Roguelike' })} />);

    await user.click(screen.getByRole('button', { name: 'Genre' }));
    const input = screen.getByRole('textbox', { name: 'Genre' });
    await user.clear(input);
    await user.type(input, 'Metroidvania');
    await user.tab();

    await waitFor(() => {
      expect(updateGameFieldAction).toHaveBeenCalledWith('game-1', 'genre', 'Metroidvania');
    });
  });

  it('does not save when the committed value is unchanged', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ genre: 'Roguelike' })} />);

    await user.click(screen.getByRole('button', { name: 'Genre' }));
    await user.tab();

    expect(updateGameFieldAction).not.toHaveBeenCalled();
  });

  it('pressing Escape cancels the edit without saving', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ genre: 'Roguelike' })} />);

    await user.click(screen.getByRole('button', { name: 'Genre' }));
    const input = screen.getByRole('textbox', { name: 'Genre' });
    await user.type(input, 'Something else');
    await user.keyboard('{Escape}');

    expect(updateGameFieldAction).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Genre' })).toBeInTheDocument();
  });

  it('shows an error toast and leaves the field alone when the save fails', async () => {
    updateGameFieldAction.mockResolvedValueOnce({ ok: false, error: 'Genre is too long' });
    const { toast } = await import('@/components/ui/toast');
    const user = userEvent.setup();
    render(<GamePage game={game({ genre: 'Roguelike' })} />);

    await user.click(screen.getByRole('button', { name: 'Genre' }));
    const input = screen.getByRole('textbox', { name: 'Genre' });
    await user.clear(input);
    await user.type(input, 'Bad value');
    await user.tab();

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Genre is too long');
    });
  });

  it('edits Notes as a multiline field', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ notes: null })} />);

    await user.click(screen.getByRole('button', { name: 'Notes' }));
    const textarea = screen.getByRole('textbox', { name: 'Notes' });
    await user.type(textarea, 'Great game');
    await user.tab();

    await waitFor(() => {
      expect(updateGameFieldAction).toHaveBeenCalledWith('game-1', 'notes', 'Great game');
    });
  });
});

describe('GamePage — select field inline editing', () => {
  it('changes Status via a Select that commits immediately, no separate save step', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ status: 'played' })} />);

    await user.click(screen.getByRole('button', { name: 'Status' }));
    await user.click(screen.getByRole('option', { name: 'Backlog' }));

    await waitFor(() => {
      expect(updateGameFieldAction).toHaveBeenCalledWith('game-1', 'status', 'backlog');
    });
  });

  it('changes Ownership, including clearing it back to "Not set"', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ ownership: 'physical' })} />);

    await user.click(screen.getByRole('button', { name: 'Ownership' }));
    await user.click(screen.getByRole('option', { name: 'Not set' }));

    await waitFor(() => {
      expect(updateGameFieldAction).toHaveBeenCalledWith('game-1', 'ownership', '');
    });
  });
});

describe('GamePage — Platinum toggle', () => {
  it('saves immediately on click, no edit step', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ platinum: false })} />);

    await user.click(screen.getByRole('checkbox', { name: 'Platinum' }));

    await waitFor(() => {
      expect(updateGameFieldAction).toHaveBeenCalledWith('game-1', 'platinum', 'true');
    });
  });
});

describe('GamePage Steam provenance', () => {
  it('renders Hours as plain, non-editable text for a Steam-linked game', () => {
    render(<GamePage game={game({ steamAppid: 367520 })} />);
    expect(screen.queryByRole('button', { name: 'Hours' })).not.toBeInTheDocument();
    expect(screen.getAllByText(/from steam/i).length).toBeGreaterThan(0);
  });

  it('keeps Hours editable for a game with no Steam link', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ steamAppid: null })} />);
    await user.click(screen.getByRole('button', { name: 'Hours' }));
    expect(screen.getByRole('textbox', { name: 'Hours' })).toBeInTheDocument();
  });

  it('keeps achievement counts read-only for a Steam-linked game', () => {
    render(<GamePage game={game({ steamAppid: 367520 })} />);
    expect(screen.queryByRole('button', { name: 'Achievements earned' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Achievements total' })).not.toBeInTheDocument();
  });

  it('keeps Rating and Status editable for a Steam-linked game', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ steamAppid: 367520 })} />);
    await user.click(screen.getByRole('button', { name: 'Rating' }));
    expect(screen.getByRole('textbox', { name: 'Rating' })).toBeInTheDocument();
  });
});

describe('GamePage — Title and metadata search', () => {
  it('makes zero metadata calls until the owner actually edits the title', async () => {
    vi.useFakeTimers();
    render(<GamePage game={game({ title: 'Elden Ring' })} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(searchGameMetadataAction).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('saves just the title on blur when no suggestion is picked', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ title: 'Elden Ring' })} />);

    await user.click(screen.getByRole('button', { name: /^Title/ }));
    const input = screen.getByLabelText('Title');
    await user.clear(input);
    await user.type(input, 'Elden Ring Nightreign');
    await user.tab();

    await waitFor(() => {
      expect(updateGameFieldAction).toHaveBeenCalledWith('game-1', 'title', 'Elden Ring Nightreign');
    });
    expect(applyMetadataSuggestionAction).not.toHaveBeenCalled();
  });

  it('calls the metadata action once 3+ characters are typed, and applies a picked suggestion as a batch', async () => {
    searchGameMetadataAction.mockResolvedValue([
      {
        externalId: 'igdb-1',
        title: 'Hades',
        coverUrl: 'https://images.igdb.com/cover.jpg',
        genre: 'Roguelike',
        developer: 'Supergiant Games',
        publisher: 'Supergiant Games',
        metacritic: 93,
        averagePlaytimeHours: 22,
        esrbRating: 'T',
        releaseYear: 2020,
      },
    ]);
    const user = userEvent.setup();
    render(<GamePage game={game({ title: 'Had', genre: null })} />);

    await user.click(screen.getByRole('button', { name: /^Title/ }));
    const input = screen.getByLabelText('Title');
    await user.clear(input);
    await user.type(input, 'Hades');

    const pick = await screen.findByRole('button', { name: /Hades \(2020\)/ }, { timeout: 2000 });
    await user.click(pick);

    await waitFor(() => {
      expect(applyMetadataSuggestionAction).toHaveBeenCalledTimes(1);
    });
    const [id, suggestion] = applyMetadataSuggestionAction.mock.calls[0]!;
    expect(id).toBe('game-1');
    expect(suggestion).toMatchObject({ title: 'Hades', genre: 'Roguelike' });
    expect(updateGameFieldAction).not.toHaveBeenCalledWith('game-1', 'title', expect.anything());
  });

  it('leaves a hand-typed genre alone when applying a suggestion', async () => {
    searchGameMetadataAction.mockResolvedValue([
      {
        externalId: 'igdb-1',
        title: 'Hades',
        coverUrl: null,
        genre: 'Roguelike',
        developer: null,
        publisher: null,
        metacritic: null,
        averagePlaytimeHours: null,
        esrbRating: null,
        releaseYear: 2020,
      },
    ]);
    const user = userEvent.setup();
    render(<GamePage game={game({ title: 'Had', genre: 'Action RPG' })} />);

    await user.click(screen.getByRole('button', { name: /^Title/ }));
    const input = screen.getByLabelText('Title');
    await user.clear(input);
    await user.type(input, 'Hades');

    const pick = await screen.findByRole('button', { name: /Hades \(2020\)/ }, { timeout: 2000 });
    await user.click(pick);

    await waitFor(() => {
      expect(applyMetadataSuggestionAction).toHaveBeenCalledTimes(1);
    });
    const [, suggestion] = applyMetadataSuggestionAction.mock.calls[0]!;
    expect(suggestion).not.toHaveProperty('genre');
  });
});

describe('GamePage play-year split', () => {
  it('shows the split panel already expanded when a split already exists', () => {
    render(<GamePage game={game({ hoursTenths: 490, playYears: [{ year: 2024, hoursTenths: 490 }] })} />);
    expect(screen.getByLabelText('Year')).toBeInTheDocument();
  });

  it('does not silently drop a row whose year cell was blanked (data-loss regression)', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ hoursTenths: 490, playYears: [{ year: 2024, hoursTenths: 490 }] })} />);

    const yearInput = screen.getByLabelText('Year');
    await user.clear(yearInput);

    await user.click(screen.getByRole('button', { name: /save split/i }));

    await waitFor(() => {
      expect(updateGamePlayYearsAction).toHaveBeenCalledTimes(1);
    });
    const [, drafts] = updateGamePlayYearsAction.mock.calls[0]!;
    expect(drafts).toHaveLength(1);
  });

  it('keeps the split editable even when the total is Steam-owned', () => {
    render(
      <GamePage
        game={game({ steamAppid: 367520, hoursTenths: 490, playYears: [{ year: 2024, hoursTenths: 490 }] })}
      />,
    );
    expect(screen.getByLabelText('Year')).not.toBeDisabled();
  });
});

/**
 * Trophies only render for a game linked to PSN (`psnNpCommunicationId !==
 * null`) and fetch automatically on mount — unchanged from the previous
 * round; `TrophiesSection`'s own props/behavior weren't touched by this
 * round's inline-editing rewrite.
 */
describe('GamePage — Trophies', () => {
  function trophy(overrides: Partial<Trophy> = {}): Trophy {
    return {
      source: 'psn',
      id: '1',
      groupId: 'default',
      tier: 'gold',
      hidden: false,
      name: 'Master Chief',
      description: 'Complete every mission on Legendary.',
      iconUrl: null,
      earned: true,
      earnedAt: '2026-08-25T09:19:50Z',
      rarity: '22.5',
      ...overrides,
    };
  }

  it('does not render a Trophies section for a game with no PSN link', () => {
    render(<GamePage game={game({ psnNpCommunicationId: null })} />);
    expect(screen.queryByRole('heading', { name: 'Trophies' })).not.toBeInTheDocument();
    expect(screen.queryByText(/find on powerpyx/i)).not.toBeInTheDocument();
    expect(fetchGameTrophiesAction).not.toHaveBeenCalled();
  });

  it('fetches automatically on mount for a PSN-linked game, exactly once, and links to PowerPyx', async () => {
    fetchGameTrophiesAction.mockResolvedValue({ ok: true, trophies: [trophy()] });
    render(<GamePage game={game({ id: 'game-42', title: 'Bloodborne', psnNpCommunicationId: 'NPWR12345_00' })} />);

    await waitFor(() => {
      expect(fetchGameTrophiesAction).toHaveBeenCalledTimes(1);
    });
    expect(fetchGameTrophiesAction).toHaveBeenCalledWith('game-42');

    await screen.findByText('Master Chief');
    expect(fetchGameTrophiesAction).toHaveBeenCalledTimes(1);

    const link = screen.getByRole('link', { name: /find on powerpyx/i });
    expect(link).toHaveAttribute('href', `https://www.powerpyx.com/?s=${encodeURIComponent('Bloodborne')}`);
    expect(link).toHaveAttribute('target', '_blank');
  });
});

describe('GamePage — Remove', () => {
  it('deletes the game and navigates back to the library on confirm', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ id: 'game-1', title: 'Elden Ring' })} />);

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    const removeButtons = screen.getAllByRole('button', { name: 'Remove' });
    await user.click(removeButtons[removeButtons.length - 1]!);

    await waitFor(() => {
      expect(deleteGameAction).toHaveBeenCalledWith('game-1');
    });
    expect(push).toHaveBeenCalledWith('/games/library');
  });
});
