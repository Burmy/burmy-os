import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ActionResult } from '@/features/games/action-result';
import type { GameSuggestion } from '@/server/games/metadata';

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
const updateGameCollectionAction = vi.fn(
  async (_id: string, _collectionId: string | null): Promise<ActionResult> => ({ ok: true }),
);

vi.mock('@/features/games/game-actions', () => ({
  updateGameFieldAction: (...args: [string, string, string]) => updateGameFieldAction(...args),
  applyMetadataSuggestionAction: (...args: [string, unknown]) =>
    applyMetadataSuggestionAction(...args),
  updateGamePlayYearsAction: (...args: [string, unknown]) => updateGamePlayYearsAction(...args),
  deleteGameAction: (...args: [string]) => deleteGameAction(...args),
  updateGameCollectionAction: (...args: [string, string | null]) =>
    updateGameCollectionAction(...args),
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
    collectionId: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * Spread FIRST at every call site below so a test that does care can override
 * any of the three explicitly — see "GamePage — collection picker".
 *
 * This once said collections were "exercised in `games-collections.test.tsx`",
 * which is a file that does not exist. `games-collections.test.ts` covers the
 * pure grouping functions and `games-game-table.test.tsx` covers the nested
 * rows, but the picker below — the only way to put a game INTO a collection —
 * had no test at all, and `updateGameCollectionAction` was missing from the
 * module mock above, so calling it would have thrown.
 */
const collectionDefaults = {
  members: [],
  collection: null,
  collectionOptions: [],
  collectionCandidates: [],
} as const;

describe('GamePage — read display', () => {
  it('renders every field formatted, with no inputs visible until clicked', () => {
    render(<GamePage {...collectionDefaults} game={game()} />);

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
    render(
      <GamePage
        {...collectionDefaults}
        game={game({ ownership: null, genre: null, developer: null, publisher: null })}
      />,
    );
    expect(screen.getAllByText('Not set').length).toBeGreaterThan(0);
  });
});

describe('GamePage — text field inline editing', () => {
  it('reveals a real input on click and saves the field on blur', async () => {
    const user = userEvent.setup();
    render(<GamePage {...collectionDefaults} game={game({ genre: 'Roguelike' })} />);

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
    render(<GamePage {...collectionDefaults} game={game({ genre: 'Roguelike' })} />);

    await user.click(screen.getByRole('button', { name: 'Genre' }));
    await user.tab();

    expect(updateGameFieldAction).not.toHaveBeenCalled();
  });

  it('pressing Escape cancels the edit without saving', async () => {
    const user = userEvent.setup();
    render(<GamePage {...collectionDefaults} game={game({ genre: 'Roguelike' })} />);

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
    render(<GamePage {...collectionDefaults} game={game({ genre: 'Roguelike' })} />);

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
    render(<GamePage {...collectionDefaults} game={game({ notes: null })} />);

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
    render(<GamePage {...collectionDefaults} game={game({ status: 'played' })} />);

    await user.click(screen.getByRole('button', { name: 'Status' }));
    await user.click(screen.getByRole('option', { name: 'Backlog' }));

    await waitFor(() => {
      expect(updateGameFieldAction).toHaveBeenCalledWith('game-1', 'status', 'backlog');
    });
  });

  it('changes Ownership, including clearing it back to "Not set"', async () => {
    const user = userEvent.setup();
    render(<GamePage {...collectionDefaults} game={game({ ownership: 'physical' })} />);

    await user.click(screen.getByRole('button', { name: 'Ownership' }));
    await user.click(screen.getByRole('option', { name: 'Not set' }));

    await waitFor(() => {
      expect(updateGameFieldAction).toHaveBeenCalledWith('game-1', 'ownership', '');
    });
  });
});

/**
 * The "Part of" picker — the only route in the app from a flat library to a
 * nested one, and until now completely untested. The owner's 185 rows all have
 * `collection_id = NULL`, so this control is the whole difference between seven
 * loose Uncharted cards and one that expands.
 */
describe('GamePage — collection picker', () => {
  const NDC = { id: 'ndc', title: 'Uncharted: The Nathan Drake Collection' };

  it('files a standalone game into a collection', async () => {
    const user = userEvent.setup();
    render(
      <GamePage
        {...collectionDefaults}
        collectionOptions={[NDC]}
        game={game({ id: 'uc1', title: "Uncharted: Drake's Fortune Remastered" })}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Part of/ }));
    // The picker is a searchable dialog, not a <select> — with 179 games a
    // plain option list is 178 rows to scroll past. Search then pick.
    await user.type(screen.getByRole('textbox', { name: 'Search games' }), 'nathan');
    await user.click(screen.getByRole('button', { name: NDC.title }));

    await waitFor(() => {
      expect(updateGameCollectionAction).toHaveBeenCalledWith('uc1', 'ndc');
    });
  });

  it('takes a game back out of its collection, passing null rather than an empty string', async () => {
    // The action's own signature distinguishes them; the picker's "no
    // collection" option has value `''`, so the component has to translate.
    const user = userEvent.setup();
    render(
      <GamePage
        {...collectionDefaults}
        collection={NDC}
        collectionOptions={[NDC]}
        game={game({ id: 'uc1', collectionId: 'ndc' })}
      />,
    );

    // Clearing is its own control now, not an option inside the list: "remove
    // this from its set" is a different intent from "choose a set", and
    // hiding it among the collections made it the easiest thing to hit by
    // accident while scrolling.
    await user.click(screen.getByRole('button', { name: `Remove from ${NDC.title}` }));

    await waitFor(() => {
      expect(updateGameCollectionAction).toHaveBeenCalledWith('uc1', null);
    });
  });

  it('shows the current collection as the field value', () => {
    render(
      <GamePage {...collectionDefaults} collection={NDC} collectionOptions={[NDC]} game={game()} />,
    );

    // The accessible name is "Part of <collection>" — the field and its value
    // — while the visible text stays just the value.
    expect(screen.getByRole('button', { name: `Part of ${NDC.title}` })).toHaveTextContent(
      NDC.title,
    );
  });

  it('offers no picker at all on a row that HOLDS games', () => {
    // The one-level rule. A disabled control would imply it might one day be
    // allowed; there is no such future.
    render(
      <GamePage
        {...collectionDefaults}
        members={[
          {
            id: 'uc1',
            title: "Uncharted: Drake's Fortune Remastered",
            status: 'played',
            coverUrl: null,
            platform: 'ps4',
            rating: null,
            firstPlayedYear: null,
            achievementsUnlocked: null,
            achievementsTotal: null,
            platinum: false,
          },
        ]}
        collectionOptions={[NDC]}
        game={game({ id: 'ndc', title: NDC.title })}
      />,
    );

    expect(screen.queryByRole('button', { name: /Part of/ })).not.toBeInTheDocument();
  });
});

describe('GamePage — Platinum toggle', () => {
  it('saves immediately on click, no edit step', async () => {
    const user = userEvent.setup();
    render(<GamePage {...collectionDefaults} game={game({ platinum: false })} />);

    await user.click(screen.getByRole('checkbox', { name: 'Platinum' }));

    await waitFor(() => {
      expect(updateGameFieldAction).toHaveBeenCalledWith('game-1', 'platinum', 'true');
    });
  });
});

describe('GamePage Steam provenance', () => {
  it('renders Hours as plain, non-editable text for a Steam-linked game', () => {
    render(<GamePage {...collectionDefaults} game={game({ steamAppid: 367520 })} />);
    expect(screen.queryByRole('button', { name: 'Hours' })).not.toBeInTheDocument();
    expect(screen.getAllByText(/from steam/i).length).toBeGreaterThan(0);
  });

  it('keeps Hours editable for a game with no Steam link', async () => {
    const user = userEvent.setup();
    render(<GamePage {...collectionDefaults} game={game({ steamAppid: null })} />);
    await user.click(screen.getByRole('button', { name: 'Hours' }));
    expect(screen.getByRole('textbox', { name: 'Hours' })).toBeInTheDocument();
  });

  it('keeps achievement counts read-only for a Steam-linked game', () => {
    render(<GamePage {...collectionDefaults} game={game({ steamAppid: 367520 })} />);
    expect(screen.queryByRole('button', { name: 'Achievements earned' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Achievements total' })).not.toBeInTheDocument();
  });

  it('keeps Rating and Status editable for a Steam-linked game', () => {
    render(<GamePage {...collectionDefaults} game={game({ steamAppid: 367520 })} />);
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
    render(<GamePage {...collectionDefaults} game={game({ rating: 5 })} />);

    expect(screen.getByRole('radio', { name: '5 stars' })).toBeChecked();

    await user.click(screen.getByRole('radio', { name: '3 stars' }));

    await waitFor(() => {
      expect(updateGameFieldAction).toHaveBeenCalledWith('game-1', 'rating', '3');
    });
  });

  it('clears the rating when the already-selected star is clicked again', async () => {
    const user = userEvent.setup();
    render(<GamePage {...collectionDefaults} game={game({ rating: 4 })} />);

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
    render(<GamePage {...collectionDefaults} game={game({ title: 'Elden Ring' })} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(searchGameMetadataAction).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('saves just the title on blur when no suggestion is picked', async () => {
    const user = userEvent.setup();
    render(<GamePage {...collectionDefaults} game={game({ title: 'Elden Ring' })} />);

    await user.click(screen.getByRole('button', { name: /^Title/ }));
    const input = screen.getByLabelText('Title');
    await user.clear(input);
    await user.type(input, 'Elden Ring Nightreign');
    await user.tab();

    await waitFor(() => {
      expect(updateGameFieldAction).toHaveBeenCalledWith(
        'game-1',
        'title',
        'Elden Ring Nightreign',
      );
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
    render(<GamePage {...collectionDefaults} game={game({ title: 'Had', genre: null })} />);

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
    render(<GamePage {...collectionDefaults} game={game({ title: 'Had', genre: 'Action RPG' })} />);

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
    render(
      <GamePage
        {...collectionDefaults}
        game={game({ hoursTenths: 490, playYears: [{ year: 2024, hoursTenths: 490 }] })}
      />,
    );
    expect(screen.getByLabelText('Year')).toBeInTheDocument();
  });

  it('does not silently drop a row whose year cell was blanked (data-loss regression)', async () => {
    const user = userEvent.setup();
    render(
      <GamePage
        {...collectionDefaults}
        game={game({ hoursTenths: 490, playYears: [{ year: 2024, hoursTenths: 490 }] })}
      />,
    );

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
        {...collectionDefaults}
        game={game({
          steamAppid: 367520,
          hoursTenths: 490,
          playYears: [{ year: 2024, hoursTenths: 490 }],
        })}
      />,
    );
    expect(screen.getByLabelText('Year')).not.toBeDisabled();
  });
});

describe('GamePage — Remove', () => {
  it('deletes the game and navigates back to the library on confirm', async () => {
    const user = userEvent.setup();
    render(<GamePage {...collectionDefaults} game={game({ id: 'game-1', title: 'Elden Ring' })} />);

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    const removeButtons = screen.getAllByRole('button', { name: 'Remove' });
    await user.click(removeButtons[removeButtons.length - 1]!);

    await waitFor(() => {
      expect(deleteGameAction).toHaveBeenCalledWith('game-1');
    });
    expect(push).toHaveBeenCalledWith('/games/library');
  });
});
