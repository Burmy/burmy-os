import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GameSuggestion } from '@/server/games/metadata';
import type { Trophy } from '@/server/games/psn';

const searchGameMetadataAction = vi.fn(async (_title: string): Promise<GameSuggestion[]> => []);

vi.mock('@/features/games/metadata-actions', () => ({
  searchGameMetadataAction,
}));

const updateGameAction = vi.fn(async (_id: string, _formData: FormData) => ({ ok: true as const }));
const deleteGameAction = vi.fn(async (_id: string) => ({ ok: true as const }));

vi.mock('@/features/games/game-actions', () => ({
  updateGameAction: (...args: [string, FormData]) => updateGameAction(...args),
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

/**
 * Regression coverage for the "metadata lookup fires every time an existing
 * game is opened" bug. Opening an existing game seeds the title field from
 * `game.title`, which is almost always >= the 3-character search minimum —
 * the debounced search effect used to key off `title` alone and fire on
 * mount, hitting IGDB for nothing on every single page visit. See
 * `titleEditedRef` in `game-page.tsx` for the fix.
 */
describe('GamePage metadata search', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('makes zero metadata calls just from opening an existing game', async () => {
    vi.useFakeTimers();
    render(<GamePage game={game({ title: 'Elden Ring' })} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(searchGameMetadataAction).not.toHaveBeenCalled();
  });

  it('calls the metadata action once the owner actually edits the title field', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ title: 'Elden Ring' })} />);

    const titleInput = screen.getByLabelText('Title');
    await user.clear(titleInput);
    await user.type(titleInput, 'Bloodborne');

    await waitFor(
      () => {
        expect(searchGameMetadataAction).toHaveBeenCalledTimes(1);
      },
      { timeout: 2000 },
    );
    expect(searchGameMetadataAction).toHaveBeenCalledWith('Bloodborne');
  });
});

/**
 * Regression coverage for "changing a game's cover art does nothing" — see
 * `game-page.tsx`'s own doc comment on `coverUrl`'s deliberately different
 * guard from genre/developer/publisher.
 */
describe('GamePage cover art', () => {
  const OLD_COVER = 'https://images.igdb.com/igdb/image/upload/t_cover_big_2x/old.jpg';
  const NEW_COVER = 'https://images.igdb.com/igdb/image/upload/t_cover_big_2x/new.jpg';

  function suggestion(): GameSuggestion {
    return {
      externalId: 'igdb-1',
      title: 'Hades',
      coverUrl: NEW_COVER,
      genre: 'Roguelike',
      developer: 'Supergiant Games',
      publisher: 'Supergiant Games',
      metacritic: 93,
      averagePlaytimeHours: 22,
      esrbRating: 'T',
      releaseYear: 2020,
    };
  }

  async function pickTheSuggestion(existingCover: string | null): Promise<FormData> {
    searchGameMetadataAction.mockResolvedValue([suggestion()]);
    const user = userEvent.setup();
    render(<GamePage game={game({ title: 'Hades', coverUrl: existingCover })} />);

    const titleInput = screen.getByLabelText('Title');
    await user.clear(titleInput);
    await user.type(titleInput, 'Hades');

    const pick = await screen.findByRole('button', { name: /Hades \(2020\)/ }, { timeout: 2000 });
    await user.click(pick);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateGameAction).toHaveBeenCalledTimes(1);
    });
    return updateGameAction.mock.calls[0]![1];
  }

  it('submits the newly picked cover for a game that already had one', async () => {
    const formData = await pickTheSuggestion(OLD_COVER);
    expect(formData.get('coverUrl')).toBe(NEW_COVER);
  });

  it('still fills the cover for a game that had none', async () => {
    const formData = await pickTheSuggestion(null);
    expect(formData.get('coverUrl')).toBe(NEW_COVER);
  });

  it('leaves a hand-typed genre alone, unlike the cover', async () => {
    const formData = await pickTheSuggestion(OLD_COVER);
    expect(formData.get('coverUrl')).toBe(NEW_COVER);
    expect(formData.get('genre')).toBe('Action RPG');
  });
});

describe('GamePage play-year split', () => {
  it('does not silently empty an existing stored split when only the year cell is blanked (data-loss regression)', async () => {
    // A game with a real stored split: 2024 -> 49h, matching the 49h total
    // exactly. The owner blanks the YEAR cell only — the hours cell still
    // reads '49'. Dropping any row with a blank year at submit time would
    // make `playYears` become `[]`, which `validateSplit` treats as
    // legitimately "no split," and `replacePlayYears` then DELETES the
    // stored split outright.
    const user = userEvent.setup();
    const existing = game({ hoursTenths: 490, playYears: [{ year: 2024, hoursTenths: 490 }] });
    render(<GamePage game={existing} />);

    // The split panel starts expanded because this game already has a split.
    const yearInput = screen.getByLabelText('Year');
    await user.clear(yearInput);

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateGameAction).toHaveBeenCalledTimes(1);
    });
    const submitted = updateGameAction.mock.calls[0]![1];
    const submittedPlayYears = JSON.parse(submitted.get('playYears') as string) as unknown[];

    expect(submittedPlayYears.length).toBeGreaterThan(0);
  });
});

/**
 * Steam owns hours/achievement counts for a linked game, so those fields
 * render read-only and say where the number came from.
 */
describe('GamePage Steam provenance', () => {
  it('renders hours read-only for a Steam-linked game', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ steamAppid: 367520 })} />);
    await user.click(screen.getByRole('tab', { name: 'Progress' }));
    expect(screen.getByLabelText('Hours played')).toBeDisabled();
  });

  it('labels the field with its source', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ steamAppid: 367520 })} />);
    await user.click(screen.getByRole('tab', { name: 'Progress' }));
    expect(screen.getAllByText(/from steam/i).length).toBeGreaterThan(0);
  });

  it('keeps hours editable for a game with no Steam link', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ steamAppid: null })} />);
    await user.click(screen.getByRole('tab', { name: 'Progress' }));
    expect(screen.getByLabelText('Hours played')).not.toBeDisabled();
  });

  it('keeps achievement counts read-only for a Steam-linked game', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ steamAppid: 367520 })} />);
    await user.click(screen.getByRole('tab', { name: 'Progress' }));
    expect(screen.getByLabelText('Achievements earned')).toBeDisabled();
    expect(screen.getByLabelText('Achievements total')).toBeDisabled();
  });

  it('keeps rating, status and notes editable for a Steam-linked game', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ steamAppid: 367520 })} />);
    await user.click(screen.getByRole('tab', { name: 'Progress' }));
    expect(screen.getByLabelText('Rating (1-5)')).not.toBeDisabled();
    expect(screen.getByLabelText('Status')).not.toBeDisabled();
    await user.click(screen.getByRole('tab', { name: 'Notes' }));
    expect(screen.getByRole('textbox', { name: 'Notes' })).not.toBeDisabled();
  });

  it('keeps the play-year split editable even when the total is Steam-owned', () => {
    render(
      <GamePage
        game={game({ steamAppid: 367520, hoursTenths: 490, playYears: [{ year: 2024, hoursTenths: 490 }] })}
      />,
    );
    expect(screen.getByLabelText('Year')).not.toBeDisabled();
  });
});

describe('GamePage — tabs', () => {
  it('defaults to the Progress tab, with Details and Notes present but inactive', () => {
    render(<GamePage game={game()} />);

    expect(screen.getByRole('tab', { name: 'Progress' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByLabelText('Status')).toBeInTheDocument();
  });

  it('switches tabs on click, without losing the other tabs\' fields from the DOM', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game()} />);

    expect(screen.getByRole('button', { name: 'Genre' })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Details' }));
    expect(screen.getByLabelText('Platform')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Notes' }));
    expect(screen.getByRole('textbox', { name: 'Notes' })).toBeInTheDocument();
    expect(screen.getByLabelText('Status')).toBeInTheDocument();
  });

  it('submits fields from every tab, not just whichever one is currently active', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ genre: 'Action RPG', notes: 'Great game' })} />);

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateGameAction).toHaveBeenCalledTimes(1);
    });
    const submitted = updateGameAction.mock.calls[0]![1];
    expect(submitted.get('genre')).toBe('Action RPG');
    expect(submitted.get('notes')).toBe('Great game');
  });
});

describe('GamePage — Genre/Developer/Publisher inline fields', () => {
  it('shows the current value as plain text, not an input, until clicked', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ genre: 'Roguelike' })} />);
    await user.click(screen.getByRole('tab', { name: 'Details' }));

    expect(screen.getByRole('button', { name: 'Genre' })).toHaveTextContent('Roguelike');
    expect(screen.queryByRole('textbox', { name: 'Genre' })).not.toBeInTheDocument();
  });

  it('reveals a real input on click and commits the typed value on blur', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ genre: 'Roguelike' })} />);
    await user.click(screen.getByRole('tab', { name: 'Details' }));

    await user.click(screen.getByRole('button', { name: 'Genre' }));
    const input = screen.getByRole('textbox', { name: 'Genre' });
    await user.clear(input);
    await user.type(input, 'Metroidvania');
    await user.tab();

    expect(screen.getByRole('button', { name: 'Genre' })).toHaveTextContent('Metroidvania');
  });

  // Simpler than the create dialog's copy of this test — a page has no
  // enclosing Radix Dialog to (not) accidentally close, so there's nothing
  // to assert beyond "the edit itself was cancelled."
  it('pressing Escape cancels the field edit', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ genre: 'Roguelike' })} />);
    await user.click(screen.getByRole('tab', { name: 'Details' }));

    await user.click(screen.getByRole('button', { name: 'Genre' }));
    const input = screen.getByRole('textbox', { name: 'Genre' });
    await user.clear(input);
    await user.type(input, 'Something else');
    await user.keyboard('{Escape}');

    expect(screen.getByRole('button', { name: 'Genre' })).toHaveTextContent('Roguelike');
  });

  it('submits the edited value, not the original', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ genre: 'Roguelike' })} />);
    await user.click(screen.getByRole('tab', { name: 'Details' }));

    await user.click(screen.getByRole('button', { name: 'Genre' }));
    const input = screen.getByRole('textbox', { name: 'Genre' });
    await user.clear(input);
    await user.type(input, 'Metroidvania');
    await user.tab();

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateGameAction).toHaveBeenCalledTimes(1);
    });
    const submitted = updateGameAction.mock.calls[0]![1];
    expect(submitted.get('genre')).toBe('Metroidvania');
  });
});

/**
 * The Trophies tab only exists for a game linked to PSN
 * (`psnNpCommunicationId !== null`) — most of the library isn't a linked
 * PS4/PS5 title, so there's no empty state to show for the common case.
 * The fetch itself is live and lazy: it fires once, on the tab's first
 * activation, never again on repeat switches — see `game-page.tsx`'s
 * `handleTabChange`.
 */
describe('GamePage — Trophies tab', () => {
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

  it('does not render the Trophies tab at all for a game with no PSN link', () => {
    render(<GamePage game={game({ psnNpCommunicationId: null })} />);
    expect(screen.queryByRole('tab', { name: 'Trophies' })).not.toBeInTheDocument();
  });

  it('renders the Trophies tab for a PSN-linked game, and fetches only once on first activation', async () => {
    fetchGameTrophiesAction.mockResolvedValue({ ok: true, trophies: [trophy()] });
    const user = userEvent.setup();
    render(<GamePage game={game({ id: 'game-42', psnNpCommunicationId: 'NPWR12345_00' })} />);

    const tab = screen.getByRole('tab', { name: 'Trophies' });
    await user.click(tab);

    await waitFor(() => {
      expect(fetchGameTrophiesAction).toHaveBeenCalledTimes(1);
    });
    expect(fetchGameTrophiesAction).toHaveBeenCalledWith('game-42');

    // Switch away and back — must not fetch a second time.
    await user.click(screen.getByRole('tab', { name: 'Progress' }));
    await user.click(tab);
    expect(fetchGameTrophiesAction).toHaveBeenCalledTimes(1);
  });

  it('renders earned/unearned trophies with tier and rarity once loaded', async () => {
    fetchGameTrophiesAction.mockResolvedValue({
      ok: true,
      trophies: [
        trophy({ id: '1', name: 'Master Chief', earned: true }),
        trophy({ id: '2', name: 'Rookie', tier: 'bronze', earned: false, earnedAt: null, rarity: '80.1' }),
      ],
    });
    const user = userEvent.setup();
    render(<GamePage game={game({ psnNpCommunicationId: 'NPWR12345_00' })} />);

    await user.click(screen.getByRole('tab', { name: 'Trophies' }));

    await screen.findByText('Master Chief');
    // The "1"/"of 2 trophies earned" text is split across two <span>s —
    // matched as a function against the parent's full text content instead
    // of a single exact string.
    expect(
      screen.getByText((_, element) => element?.textContent === '1 of 2 trophies earned'),
    ).toBeInTheDocument();
    expect(screen.getByText('Rookie')).toBeInTheDocument();
    expect(screen.getByText('80.1%')).toBeInTheDocument();
  });

  it.each([
    ['not_configured', /isn't connected/i],
    ['token_expired', /needs refreshing/i],
    ['unavailable', /couldn't reach/i],
  ] as const)('renders a scoped message for a %s failure, without disabling the rest of the page', async (reason, expectedText) => {
    fetchGameTrophiesAction.mockResolvedValue({ ok: false, reason });
    const user = userEvent.setup();
    render(<GamePage game={game({ psnNpCommunicationId: 'NPWR12345_00' })} />);

    await user.click(screen.getByRole('tab', { name: 'Trophies' }));

    await screen.findByText(expectedText);
    // Progress's own fields are unaffected by a Trophies-tab failure.
    await user.click(screen.getByRole('tab', { name: 'Progress' }));
    expect(screen.getByLabelText('Status')).not.toBeDisabled();
  });
});

describe('GamePage — Remove', () => {
  it('deletes the game and navigates back to the library on confirm', async () => {
    const user = userEvent.setup();
    render(<GamePage game={game({ id: 'game-1', title: 'Elden Ring' })} />);

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    // Both the header trigger and the confirmation dialog's own button are
    // labelled "Remove" once the dialog is open — the confirmation dialog's
    // is the one added most recently to the DOM.
    const removeButtons = screen.getAllByRole('button', { name: 'Remove' });
    await user.click(removeButtons[removeButtons.length - 1]!);

    await waitFor(() => {
      expect(deleteGameAction).toHaveBeenCalledWith('game-1');
    });
    expect(push).toHaveBeenCalledWith('/games/library');
  });
});
