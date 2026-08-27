import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ActionResult } from '@/features/games/action-result';
import type { GameSuggestion } from '@/server/games/metadata';
import type { Trophy } from '@/server/games/trophies';

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
    releaseDate: null,
    releasePrecision: null,
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
    render(<GamePage game={game()} trophies={[]} />);

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
    render(<GamePage game={game({ ownership: null, genre: null, developer: null, publisher: null })} trophies={[]} />);
    expect(screen.getAllByText('Not set').length).toBeGreaterThan(0);
  });
});

describe('GamePage — text field inline editing', () => {
  it('reveals a real input on click and saves the field on blur', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ genre: 'Roguelike' })} trophies={[]} />);

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
    render(<GamePage game={game({ genre: 'Roguelike' })} trophies={[]} />);

    await user.click(screen.getByRole('button', { name: 'Genre' }));
    await user.tab();

    expect(updateGameFieldAction).not.toHaveBeenCalled();
  });

  it('pressing Escape cancels the edit without saving', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ genre: 'Roguelike' })} trophies={[]} />);

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
    render(<GamePage game={game({ genre: 'Roguelike' })} trophies={[]} />);

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
    render(<GamePage game={game({ notes: null })} trophies={[]} />);

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
    render(<GamePage game={game({ status: 'played' })} trophies={[]} />);

    await user.click(screen.getByRole('button', { name: 'Status' }));
    await user.click(screen.getByRole('option', { name: 'Backlog' }));

    await waitFor(() => {
      expect(updateGameFieldAction).toHaveBeenCalledWith('game-1', 'status', 'backlog');
    });
  });

  it('changes Ownership, including clearing it back to "Not set"', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ ownership: 'physical' })} trophies={[]} />);

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
    render(<GamePage game={game({ platinum: false })} trophies={[]} />);

    await user.click(screen.getByRole('checkbox', { name: 'Platinum' }));

    await waitFor(() => {
      expect(updateGameFieldAction).toHaveBeenCalledWith('game-1', 'platinum', 'true');
    });
  });
});

describe('GamePage Steam provenance', () => {
  it('renders Hours as plain, non-editable text for a Steam-linked game', () => {
    render(<GamePage game={game({ steamAppid: 367520 })} trophies={[]} />);
    expect(screen.queryByRole('button', { name: 'Hours' })).not.toBeInTheDocument();
    expect(screen.getAllByText(/from steam/i).length).toBeGreaterThan(0);
  });

  it('keeps Hours editable for a game with no Steam link', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ steamAppid: null })} trophies={[]} />);
    await user.click(screen.getByRole('button', { name: 'Hours' }));
    expect(screen.getByRole('textbox', { name: 'Hours' })).toBeInTheDocument();
  });

  it('keeps achievement counts read-only for a Steam-linked game', () => {
    render(<GamePage game={game({ steamAppid: 367520 })} trophies={[]} />);
    expect(screen.queryByRole('button', { name: 'Achievements earned' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Achievements total' })).not.toBeInTheDocument();
  });

  it('keeps Rating and Status editable for a Steam-linked game', () => {
    render(<GamePage game={game({ steamAppid: 367520 })} trophies={[]} />);
    // Rating is a directly-interactive star row now, not a click-to-reveal
    // text field — Steam owning hours/achievements must not disable it.
    expect(screen.getByRole('radiogroup', { name: 'Rating' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '4 stars' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Status' })).toBeInTheDocument();
  });
});

/**
 * Rating is the one field that commits directly on click rather than
 * revealing an input first — a star row is already the control. See
 * `rating-input.tsx`.
 */
describe('GamePage — star rating', () => {
  it('renders the current rating as selected and saves the star that is clicked', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ rating: 5 })} trophies={[]} />);

    expect(screen.getByRole('radio', { name: '5 stars' })).toBeChecked();

    await user.click(screen.getByRole('radio', { name: '3 stars' }));

    await waitFor(() => {
      expect(updateGameFieldAction).toHaveBeenCalledWith('game-1', 'rating', '3');
    });
  });

  it('clears the rating when the already-selected star is clicked again', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ rating: 4 })} trophies={[]} />);

    await user.click(screen.getByRole('radio', { name: '4 stars' }));

    // An empty value is how every other field here spells "cleared" —
    // without this there is no way back to unrated once a star is set.
    await waitFor(() => {
      expect(updateGameFieldAction).toHaveBeenCalledWith('game-1', 'rating', '');
    });
  });
});

describe('GamePage — Title and metadata search', () => {
  it('makes zero metadata calls until the owner actually edits the title', async () => {
    vi.useFakeTimers();
    render(<GamePage game={game({ title: 'Elden Ring' })} trophies={[]} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(searchGameMetadataAction).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('saves just the title on blur when no suggestion is picked', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ title: 'Elden Ring' })} trophies={[]} />);

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
    render(<GamePage game={game({ title: 'Had', genre: null })} trophies={[]} />);

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
    render(<GamePage game={game({ title: 'Had', genre: 'Action RPG' })} trophies={[]} />);

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
    render(<GamePage game={game({ hoursTenths: 490, playYears: [{ year: 2024, hoursTenths: 490 }] })} trophies={[]} />);
    expect(screen.getByLabelText('Year')).toBeInTheDocument();
  });

  it('does not silently drop a row whose year cell was blanked (data-loss regression)', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ hoursTenths: 490, playYears: [{ year: 2024, hoursTenths: 490 }] })} trophies={[]} />);

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
        trophies={[]}
      />,
    );
    expect(screen.getByLabelText('Year')).not.toBeDisabled();
  });
});

/**
 * Trophies arrive as a PROP now, read from `game_trophies` by the page's
 * Server Component. They used to be fetched from PSN in a mount effect here,
 * which cost ~1.5s on every visit and is why these tests previously waited on
 * a mocked action; there is nothing left to wait for.
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
      rarityTenths: 225,
      ...overrides,
    };
  }

  it('renders no Trophies section for a game linked to neither PSN nor Steam', () => {
    render(<GamePage game={game({ psnNpCommunicationId: null, steamAppid: null })} trophies={[]} />);
    expect(screen.queryByRole('heading', { name: 'Trophies' })).not.toBeInTheDocument();
    expect(screen.queryByText(/find on powerpyx/i)).not.toBeInTheDocument();
  });

  it('renders stored trophies immediately, with no loading state', () => {
    render(
      <GamePage
        game={game({ id: 'game-42', title: 'Bloodborne', psnNpCommunicationId: 'NPWR12345_00' })}
        trophies={[trophy()]}
      />,
    );

    // Synchronous on purpose — no `findBy`, because there is nothing async
    // left. A skeleton here would mean the live fetch had crept back in.
    expect(screen.getByText('Master Chief')).toBeInTheDocument();
    // Split across two spans (the count is `tabular font-medium`), so this
    // matches the paragraph's combined text rather than a single node.
    expect(screen.getByText(/of 1 trophies earned/i)).toBeInTheDocument();

    const link = screen.getByRole('link', { name: /find on powerpyx/i });
    expect(link).toHaveAttribute('href', `https://www.powerpyx.com/?s=${encodeURIComponent('Bloodborne')}`);
    expect(link).toHaveAttribute('target', '_blank');
  });

  /**
   * The accepted cost of refreshing only during a sync: a linked game that has
   * never been synced has no rows. That is not an error, and the empty state
   * must name the fix rather than reading like one.
   */
  it('tells the owner to sync when a linked game has no stored trophies', () => {
    render(<GamePage game={game({ psnNpCommunicationId: 'NPWR12345_00' })} trophies={[]} />);

    expect(screen.getByRole('heading', { name: 'Trophies' })).toBeInTheDocument();
    expect(screen.getByText(/run a sync from settings/i)).toBeInTheDocument();
  });

  it('renders trophies for a Steam-only game too, tierless', () => {
    render(
      <GamePage
        game={game({ psnNpCommunicationId: null, steamAppid: 367520 })}
        trophies={[trophy({ source: 'steam', tier: null, groupId: null, name: 'Charmed' })]}
      />,
    );

    expect(screen.getByText('Charmed')).toBeInTheDocument();
  });
});

describe('GamePage — Remove', () => {
  it('deletes the game and navigates back to the library on confirm', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ id: 'game-1', title: 'Elden Ring' })} trophies={[]} />);

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    const removeButtons = screen.getAllByRole('button', { name: 'Remove' });
    await user.click(removeButtons[removeButtons.length - 1]!);

    await waitFor(() => {
      expect(deleteGameAction).toHaveBeenCalledWith('game-1');
    });
    expect(push).toHaveBeenCalledWith('/games/library');
  });
});
