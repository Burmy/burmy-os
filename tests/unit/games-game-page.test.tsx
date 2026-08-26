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

/** Every field-editing test needs this first — the page opens read-only. */
async function openForEditing(rendered: Game): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(<GamePage game={rendered} />);
  await user.click(screen.getByRole('button', { name: 'Edit' }));
  return user;
}

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * The page opens read-only — a two-column profile layout (cover/platform/
 * status/rating/hours on the left, formatted text on the right), no inputs
 * anywhere, until "Edit" is clicked.
 */
describe('GamePage — view mode', () => {
  it('renders formatted values with no inputs anywhere', () => {
    render(<GamePage game={game()} />);

    expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();

    expect(screen.getByRole('heading', { name: 'Elden Ring' })).toBeInTheDocument();
    expect(screen.getByText('PS5')).toBeInTheDocument();
    expect(screen.getByText('Played')).toBeInTheDocument();
    expect(screen.getByText('136h')).toBeInTheDocument();
    expect(screen.getByText('Physical')).toBeInTheDocument();
    expect(screen.getByText('Action RPG')).toBeInTheDocument();
  });

  it('shows "Not set" for an unset field rather than leaving it blank', () => {
    render(<GamePage game={game({ ownership: null, genre: null, developer: null, publisher: null })} />);
    expect(screen.getAllByText('Not set').length).toBeGreaterThan(0);
  });

  it('switches to edit mode on "Edit", revealing real inputs', async () => {
    await openForEditing(game());

    expect(screen.getByLabelText('Title')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('Cancel discards an in-progress edit and returns to view mode without saving', async () => {
    const user = await openForEditing(game({ genre: 'Roguelike' }));

    await user.click(screen.getByRole('button', { name: 'Genre' }));
    await user.clear(screen.getByRole('textbox', { name: 'Genre' }));
    await user.type(screen.getByRole('textbox', { name: 'Genre' }), 'Something else');
    await user.tab();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(updateGameAction).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByText('Roguelike')).toBeInTheDocument();
  });

  it('a successful Save returns to view mode showing the new value', async () => {
    const user = await openForEditing(game({ genre: 'Roguelike' }));

    await user.click(screen.getByRole('button', { name: 'Genre' }));
    await user.clear(screen.getByRole('textbox', { name: 'Genre' }));
    await user.type(screen.getByRole('textbox', { name: 'Genre' }), 'Metroidvania');
    await user.tab();

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateGameAction).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByText('Metroidvania')).toBeInTheDocument();
  });
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

  it('makes zero metadata calls just from opening an existing game and entering edit mode', async () => {
    // Entering edit mode is a real (non-fake-timer) click — fake timers only
    // matter for the debounced search effect itself, which is what this
    // test is actually waiting out.
    const user = userEvent.setup();
    render(<GamePage game={game({ title: 'Elden Ring' })} />);
    await user.click(screen.getByRole('button', { name: 'Edit' }));

    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(searchGameMetadataAction).not.toHaveBeenCalled();
  });

  it('calls the metadata action once the owner actually edits the title field', async () => {
    const user = await openForEditing(game({ title: 'Elden Ring' }));

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
    const user = await openForEditing(game({ title: 'Hades', coverUrl: existingCover }));

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
    const existing = game({ hoursTenths: 490, playYears: [{ year: 2024, hoursTenths: 490 }] });
    const user = await openForEditing(existing);

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
 * render read-only and say where the number came from. No tab-switching
 * needed anymore — every section is stacked and visible at once in edit
 * mode.
 */
describe('GamePage Steam provenance', () => {
  it('renders hours read-only for a Steam-linked game', async () => {
    await openForEditing(game({ steamAppid: 367520 }));
    expect(screen.getByLabelText('Hours played')).toBeDisabled();
  });

  it('labels the field with its source', async () => {
    await openForEditing(game({ steamAppid: 367520 }));
    expect(screen.getAllByText(/from steam/i).length).toBeGreaterThan(0);
  });

  it('keeps hours editable for a game with no Steam link', async () => {
    await openForEditing(game({ steamAppid: null }));
    expect(screen.getByLabelText('Hours played')).not.toBeDisabled();
  });

  it('keeps achievement counts read-only for a Steam-linked game', async () => {
    await openForEditing(game({ steamAppid: 367520 }));
    expect(screen.getByLabelText('Achievements earned')).toBeDisabled();
    expect(screen.getByLabelText('Achievements total')).toBeDisabled();
  });

  it('keeps rating, status and notes editable for a Steam-linked game', async () => {
    await openForEditing(game({ steamAppid: 367520 }));
    expect(screen.getByLabelText('Rating (1-5)')).not.toBeDisabled();
    expect(screen.getByLabelText('Status')).not.toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Notes' })).not.toBeDisabled();
  });

  it('keeps the play-year split editable even when the total is Steam-owned', async () => {
    await openForEditing(
      game({ steamAppid: 367520, hoursTenths: 490, playYears: [{ year: 2024, hoursTenths: 490 }] }),
    );
    expect(screen.getByLabelText('Year')).not.toBeDisabled();
  });
});

describe('GamePage — Genre/Developer/Publisher inline fields', () => {
  it('shows the current value as plain text, not an input, until clicked', async () => {
    await openForEditing(game({ genre: 'Roguelike' }));

    expect(screen.getByRole('button', { name: 'Genre' })).toHaveTextContent('Roguelike');
    expect(screen.queryByRole('textbox', { name: 'Genre' })).not.toBeInTheDocument();
  });

  it('reveals a real input on click and commits the typed value on blur', async () => {
    const user = await openForEditing(game({ genre: 'Roguelike' }));

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
    const user = await openForEditing(game({ genre: 'Roguelike' }));

    await user.click(screen.getByRole('button', { name: 'Genre' }));
    const input = screen.getByRole('textbox', { name: 'Genre' });
    await user.clear(input);
    await user.type(input, 'Something else');
    await user.keyboard('{Escape}');

    expect(screen.getByRole('button', { name: 'Genre' })).toHaveTextContent('Roguelike');
  });

  it('submits the edited value, not the original', async () => {
    const user = await openForEditing(game({ genre: 'Roguelike' }));

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
 * Trophies only render at all for a game linked to PSN
 * (`psnNpCommunicationId !== null`) — most of the library isn't a linked
 * PS4/PS5 title, so there's no empty state to show for the common case.
 * The fetch itself is live and fires once, automatically, on mount — there
 * is no tab to click anymore (see `game-page.tsx`'s trophy-fetch effect).
 * One merged list, not separate Earned/Unearned tables — color (full tier
 * color vs. grayed-out) is what signals earned/unearned now.
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

  it('does not render a Trophies section at all for a game with no PSN link', () => {
    render(<GamePage game={game({ psnNpCommunicationId: null })} />);
    expect(screen.queryByRole('heading', { name: 'Trophies' })).not.toBeInTheDocument();
    expect(fetchGameTrophiesAction).not.toHaveBeenCalled();
  });

  it('fetches automatically on mount for a PSN-linked game, exactly once', async () => {
    fetchGameTrophiesAction.mockResolvedValue({ ok: true, trophies: [trophy()] });
    render(<GamePage game={game({ id: 'game-42', psnNpCommunicationId: 'NPWR12345_00' })} />);

    await waitFor(() => {
      expect(fetchGameTrophiesAction).toHaveBeenCalledTimes(1);
    });
    expect(fetchGameTrophiesAction).toHaveBeenCalledWith('game-42');

    await screen.findByText('Master Chief');
    expect(fetchGameTrophiesAction).toHaveBeenCalledTimes(1);
  });

  it('renders one merged list, color-coded by earned status, with tier and rarity', async () => {
    fetchGameTrophiesAction.mockResolvedValue({
      ok: true,
      trophies: [
        trophy({ id: '1', name: 'Master Chief', earned: true }),
        trophy({ id: '2', name: 'Rookie', tier: 'bronze', earned: false, earnedAt: null, rarity: '80.1' }),
      ],
    });
    render(<GamePage game={game({ psnNpCommunicationId: 'NPWR12345_00' })} />);

    await screen.findByText('Master Chief');
    // The "1"/"of 2 trophies earned" text is split across two <span>s —
    // matched as a function against the parent's full text content instead
    // of a single exact string.
    expect(
      screen.getByText((_, element) => element?.textContent === '1 of 2 trophies earned'),
    ).toBeInTheDocument();

    // Both rows sit in the same table — no separate Earned/Unearned headings.
    expect(screen.queryByText('Earned (1)')).not.toBeInTheDocument();
    expect(screen.queryByText('Unearned (1)')).not.toBeInTheDocument();
    const rookieRow = screen.getByText('Rookie').closest('tr');
    expect(rookieRow).not.toBeNull();
    expect(screen.getByText('80.1%')).toBeInTheDocument();
    // The unearned row's tier badge is grayed out — the color-coding signal.
    expect(rookieRow!.querySelector('.grayscale')).not.toBeNull();
    const masterChiefRow = screen.getByText('Master Chief').closest('tr');
    expect(masterChiefRow!.querySelector('.grayscale')).toBeNull();
  });

  it.each([
    ['not_configured', /isn't connected/i],
    ['token_expired', /needs refreshing/i],
    ['unavailable', /couldn't reach/i],
  ] as const)('renders a scoped message for a %s failure, without affecting the rest of the page', async (reason, expectedText) => {
    fetchGameTrophiesAction.mockResolvedValue({ ok: false, reason });
    render(<GamePage game={game({ psnNpCommunicationId: 'NPWR12345_00' })} />);

    await screen.findByText(expectedText);
    // The rest of the (view-mode) page is unaffected by a trophy fetch failure.
    expect(screen.getByRole('heading', { name: 'Elden Ring' })).toBeInTheDocument();
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
