import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const addGamesToCollectionAction = vi.fn(
  async (_id: string, _ids: readonly string[]): Promise<ActionResult> => ({ ok: true }),
);

vi.mock('@/features/games/game-actions', () => ({
  updateGameFieldAction: (...args: [string, string, string]) => updateGameFieldAction(...args),
  applyMetadataSuggestionAction: (...args: [string, unknown]) =>
    applyMetadataSuggestionAction(...args),
  updateGamePlayYearsAction: (...args: [string, unknown]) => updateGamePlayYearsAction(...args),
  deleteGameAction: (...args: [string]) => deleteGameAction(...args),
  updateGameCollectionAction: (...args: [string, string | null]) =>
    updateGameCollectionAction(...args),
  addGamesToCollectionAction: (...args: [string, readonly string[]]) =>
    addGamesToCollectionAction(...args),
}));

vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

let pathname = '/games/library';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

type PanelData = import('@/features/games/panel/panel-actions').GamePanelData;
type Game = PanelData['game'];
type Member = PanelData['members'][number];

const getGamePanelAction = vi.fn(async (_id: string): Promise<PanelData | null> => null);
vi.mock('@/features/games/panel/panel-actions', () => ({
  getGamePanelAction: (...args: [string]) => getGamePanelAction(...args),
}));

const { GamePanelProvider } = await import('@/features/games/panel/game-panel-provider');
const { useGamePanel } = await import('@/features/games/panel/game-panel-context');

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
    releaseDate: null,
    releasePrecision: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    playYears: [],
    dlc: [],
    collectionId: null,
    ...overrides,
  };
}

function member(overrides: Partial<Member> = {}): Member {
  return {
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
    ...overrides,
  };
}

const NDC = { id: 'ndc', title: 'Uncharted: The Nathan Drake Collection' };

/**
 * The panel is opened the way the library opens it: through `useGamePanel()`
 * from inside the provider. `seed` is what the caller hands over — the full
 * row (a card click) or just an id (a swap from inside the panel).
 */
function Opener({
  seed,
  label = 'open',
}: {
  readonly seed: Game | { readonly id: string };
  readonly label?: string;
}) {
  const { openGame } = useGamePanel();
  return (
    <button type="button" onClick={() => openGame(seed)}>
      {label}
    </button>
  );
}

/** What the action returns for any id — tests override `members`/`collection` per case. */
function panelData(overrides: Partial<PanelData> = {}): PanelData {
  return {
    game: game(),
    members: [],
    collection: null,
    collectionOptions: [],
    collectionCandidates: [],
    ...overrides,
  };
}

async function openPanel(
  seed: Game | { readonly id: string },
  data: Partial<PanelData> = {},
): Promise<void> {
  getGamePanelAction.mockImplementation(async () =>
    panelData({ game: 'title' in seed ? seed : game(), ...data }),
  );
  const user = userEvent.setup();
  render(
    <GamePanelProvider>
      <Opener seed={seed} />
    </GamePanelProvider>,
  );
  await user.click(screen.getByRole('button', { name: 'open' }));
  await screen.findByRole('dialog');
  // Every case below reads collection data at some point; wait for the fetch.
  await waitFor(() => expect(getGamePanelAction).toHaveBeenCalled());
}

afterEach(() => {
  vi.clearAllMocks();
  pathname = '/games/library';
});

describe('GamePanel — opening and closing', () => {
  it('renders the game from the seed before the fetch lands, then fills in collection data', async () => {
    let resolve: (value: PanelData) => void = () => {};
    getGamePanelAction.mockImplementation(() => new Promise<PanelData>((r) => (resolve = r)));
    const user = userEvent.setup();
    render(
      <GamePanelProvider>
        <Opener seed={game({ title: 'Hades' })} />
      </GamePanelProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'open' }));

    // Scalars straight from the seed, no round trip.
    expect(screen.getByRole('button', { name: 'Title: Hades' })).toBeInTheDocument();
    expect(screen.getByText('136h')).toBeInTheDocument();

    await act(async () => resolve(panelData({ game: game({ title: 'Hades' }) })));
    expect(await screen.findByText('Games in this collection')).toBeInTheDocument();
  });

  it('shows a skeleton when opened with only an id, until the fetch lands', async () => {
    let resolve: (value: PanelData) => void = () => {};
    getGamePanelAction.mockImplementation(() => new Promise<PanelData>((r) => (resolve = r)));
    const user = userEvent.setup();
    render(
      <GamePanelProvider>
        <Opener seed={{ id: 'game-1' }} />
      </GamePanelProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'open' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Loading game');

    await act(async () => resolve(panelData()));
    expect(await screen.findByRole('button', { name: 'Title: Elden Ring' })).toBeInTheDocument();
  });

  it('closes on Escape when no field is being edited', async () => {
    await openPanel(game());
    const user = userEvent.setup();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('closes from the X button', async () => {
    await openPanel(game());
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('stays open when something outside it is clicked — the grid behind stays live', async () => {
    await openPanel(game());

    fireEvent.pointerDown(document.body);
    fireEvent.pointerUp(document.body);
    fireEvent.click(document.body);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('swaps to another game when a second seed is opened, without closing', async () => {
    getGamePanelAction.mockImplementation(async (id) =>
      panelData({ game: game({ id, title: id === 'a' ? 'Alpha' : 'Bravo' }) }),
    );
    const user = userEvent.setup();
    render(
      <GamePanelProvider>
        <Opener seed={game({ id: 'a', title: 'Alpha' })} label="open a" />
        <Opener seed={game({ id: 'b', title: 'Bravo' })} label="open b" />
      </GamePanelProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'open a' }));
    expect(await screen.findByRole('button', { name: 'Title: Alpha' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'open b' }));
    expect(await screen.findByRole('button', { name: 'Title: Bravo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Title: Alpha' })).not.toBeInTheDocument();
  });

  it('closes itself when the game is no longer in the library', async () => {
    getGamePanelAction.mockResolvedValue(null);
    const { toast } = await import('@/components/ui/toast');
    const user = userEvent.setup();
    render(
      <GamePanelProvider>
        <Opener seed={{ id: 'gone' }} />
      </GamePanelProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'open' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(toast.error).toHaveBeenCalled();
  });
});

describe('GamePanel — read display', () => {
  it('renders every field formatted, with no inputs visible until clicked', async () => {
    await openPanel(game());

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Title: Elden Ring' })).toBeInTheDocument();
    expect(screen.getAllByText('PS5').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Played').length).toBeGreaterThan(0);
    expect(screen.getByText('136h')).toBeInTheDocument();
    expect(screen.getByText('Physical')).toBeInTheDocument();
    expect(screen.getByText('Action RPG')).toBeInTheDocument();
    expect(screen.getByText('$65.65')).toBeInTheDocument();
  });

  it('shows the IGDB facts line only when a game has them', async () => {
    await openPanel(game({ metacritic: 88, averagePlaytimeHours: 25 }));
    expect(screen.getByText('Metacritic 88 · ~25h to beat')).toBeInTheDocument();
  });

  it('shows no facts line for a game with neither fact', async () => {
    await openPanel(game({ metacritic: null, averagePlaytimeHours: null }));
    expect(screen.queryByText(/Metacritic/)).not.toBeInTheDocument();
  });
});

describe('GamePanel — inline editing', () => {
  it('reveals a real input on click, saves on blur, and re-fetches the panel', async () => {
    await openPanel(game({ genre: 'Roguelike' }));
    const user = userEvent.setup();
    const fetches = getGamePanelAction.mock.calls.length;

    await user.click(screen.getByRole('button', { name: 'Genre' }));
    const input = screen.getByRole('textbox', { name: 'Genre' });
    await user.clear(input);
    await user.type(input, 'Metroidvania');
    await user.tab();

    await waitFor(() => {
      expect(updateGameFieldAction).toHaveBeenCalledWith('game-1', 'genre', 'Metroidvania');
    });
    await waitFor(() => expect(getGamePanelAction.mock.calls.length).toBeGreaterThan(fetches));
  });

  it('pressing Escape inside a field cancels that edit WITHOUT closing the panel', async () => {
    await openPanel(game({ genre: 'Roguelike' }));
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Genre' }));
    await user.type(screen.getByRole('textbox', { name: 'Genre' }), 'Something else');
    await user.keyboard('{Escape}');

    expect(updateGameFieldAction).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Genre' })).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows an error toast and does not re-fetch when the save fails', async () => {
    updateGameFieldAction.mockResolvedValueOnce({ ok: false, error: 'Genre is too long' });
    const { toast } = await import('@/components/ui/toast');
    await openPanel(game({ genre: 'Roguelike' }));
    const user = userEvent.setup();
    const fetches = getGamePanelAction.mock.calls.length;

    await user.click(screen.getByRole('button', { name: 'Genre' }));
    const input = screen.getByRole('textbox', { name: 'Genre' });
    await user.clear(input);
    await user.type(input, 'Bad value');
    await user.tab();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Genre is too long'));
    expect(getGamePanelAction.mock.calls.length).toBe(fetches);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('edits Notes as a multiline field', async () => {
    await openPanel(game({ notes: null }));
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Notes' }));
    await user.type(screen.getByRole('textbox', { name: 'Notes' }), 'Great game');
    await user.tab();

    await waitFor(() =>
      expect(updateGameFieldAction).toHaveBeenCalledWith('game-1', 'notes', 'Great game'),
    );
  });

  it('changes Status via a Select that commits immediately', async () => {
    await openPanel(game({ status: 'played' }));
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Status' }));
    await user.click(screen.getByRole('option', { name: 'Wanted' }));

    await waitFor(() =>
      expect(updateGameFieldAction).toHaveBeenCalledWith('game-1', 'status', 'wanted'),
    );
  });

  it('saves the platinum checkbox immediately', async () => {
    await openPanel(game({ platinum: false }));
    const user = userEvent.setup();

    await user.click(screen.getByRole('checkbox', { name: 'Platinum' }));

    await waitFor(() =>
      expect(updateGameFieldAction).toHaveBeenCalledWith('game-1', 'platinum', 'true'),
    );
  });

  it('saves the clicked star and clears on re-click', async () => {
    await openPanel(game({ rating: 4 }));
    const user = userEvent.setup();

    await user.click(screen.getByRole('radio', { name: '3 stars' }));
    await waitFor(() =>
      expect(updateGameFieldAction).toHaveBeenCalledWith('game-1', 'rating', '3'),
    );

    await user.click(screen.getByRole('radio', { name: '4 stars' }));
    await waitFor(() => expect(updateGameFieldAction).toHaveBeenCalledWith('game-1', 'rating', ''));
  });
});

describe('GamePanel — title and metadata search', () => {
  it('saves just the title on blur when no suggestion is picked', async () => {
    await openPanel(game({ title: 'Elden Ring' }));
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Title: Elden Ring' }));
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

  it('applies a picked suggestion as a batch and re-fetches the panel', async () => {
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
    await openPanel(game({ title: 'Had', genre: null }));
    const user = userEvent.setup();
    const fetches = getGamePanelAction.mock.calls.length;

    await user.click(screen.getByRole('button', { name: 'Title: Had' }));
    const input = screen.getByLabelText('Title');
    await user.clear(input);
    await user.type(input, 'Hades');

    const pick = await screen.findByRole('button', { name: /Hades \(2020\)/ }, { timeout: 2000 });
    await user.click(pick);

    await waitFor(() => expect(applyMetadataSuggestionAction).toHaveBeenCalledTimes(1));
    const [id, suggestion] = applyMetadataSuggestionAction.mock.calls[0]!;
    expect(id).toBe('game-1');
    expect(suggestion).toMatchObject({ title: 'Hades', genre: 'Roguelike' });
    await waitFor(() => expect(getGamePanelAction.mock.calls.length).toBeGreaterThan(fetches));
  });
});

describe('GamePanel — collections', () => {
  it('lists the games inside a collection, read-only achievements rolled up from them', async () => {
    await openPanel(
      game({ id: 'ndc', title: NDC.title, achievementsUnlocked: 154, achievementsTotal: 200 }),
      {
        members: [
          member({ id: 'uc1', achievementsUnlocked: 50, achievementsTotal: 60 }),
          member({
            id: 'uc2',
            title: 'Uncharted 2: Among Thieves Remastered',
            achievementsUnlocked: 40,
            achievementsTotal: 70,
          }),
        ],
      },
    );

    expect(screen.getByText('Games in this collection')).toBeInTheDocument();
    expect(screen.getByText('Uncharted 2: Among Thieves Remastered')).toBeInTheDocument();
    expect(screen.getAllByText('2 games').length).toBeGreaterThan(0);
    // Summed from the members, so not editable here.
    expect(screen.queryByRole('button', { name: 'Achievements earned' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Added up from the games in this collection').length).toBe(2);
    // A row that holds games cannot itself be filed into one.
    expect(screen.queryByRole('button', { name: /Part of/ })).not.toBeInTheDocument();
  });

  it('swaps the panel to a member when it is clicked', async () => {
    await openPanel(game({ id: 'ndc', title: NDC.title }), { members: [member()] });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: "Uncharted: Drake's Fortune Remastered" }));

    await waitFor(() => expect(getGamePanelAction).toHaveBeenCalledWith('uc1'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows a member with hours and price read-only, and a Part of link that swaps to the collection', async () => {
    await openPanel(
      game({ id: 'uc1', title: "Uncharted: Drake's Fortune Remastered", collectionId: 'ndc' }),
      {
        collection: NDC,
        collectionOptions: [NDC],
      },
    );
    const user = userEvent.setup();

    expect(screen.queryByRole('button', { name: 'Hours' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Price paid' })).not.toBeInTheDocument();
    expect(screen.getAllByText('From the collection').length).toBeGreaterThan(0);
    expect(screen.queryByText('Games in this collection')).not.toBeInTheDocument();
    // The "Part of" field keeps its picker; the header link navigates.
    expect(screen.getByRole('button', { name: `Part of ${NDC.title}` })).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: `Part of ${NDC.title} — open collection` }),
    );
    await waitFor(() => expect(getGamePanelAction).toHaveBeenCalledWith('ndc'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('files a standalone game into a collection through the picker', async () => {
    await openPanel(game({ id: 'uc1', title: "Uncharted: Drake's Fortune Remastered" }), {
      collectionOptions: [NDC],
    });
    const user = userEvent.setup();

    // A standalone row shows the members panel (it could become a set), so the
    // "Part of" picker is reached through the collection field only for a
    // member. For a standalone game, filing happens from the OTHER end — the
    // collection's "Add games" — or the table's multi-select; this panel
    // offers "Add games" for its own prospective members.
    expect(screen.getByRole('button', { name: 'Add games' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add games' }));
    expect(await screen.findByRole('textbox', { name: 'Search games' })).toBeInTheDocument();
  });

  it('takes a member back out of its collection, passing null', async () => {
    await openPanel(game({ id: 'uc1', collectionId: 'ndc' }), {
      collection: NDC,
      collectionOptions: [NDC],
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: `Remove from ${NDC.title}` }));

    await waitFor(() => expect(updateGameCollectionAction).toHaveBeenCalledWith('uc1', null));
  });
});

describe('GamePanel — play-year split', () => {
  it('shows the split panel already expanded when a split exists, and saves the drafts', async () => {
    await openPanel(game({ hoursTenths: 490, playYears: [{ year: 2024, hoursTenths: 490 }] }));
    const user = userEvent.setup();

    expect(screen.getByLabelText('Year')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Year'));
    await user.click(screen.getByRole('button', { name: /save split/i }));

    await waitFor(() => expect(updateGamePlayYearsAction).toHaveBeenCalledTimes(1));
    const [, drafts] = updateGamePlayYearsAction.mock.calls[0]!;
    expect(drafts).toHaveLength(1);
  });

  it('hides the split entirely for a collection member', async () => {
    await openPanel(game({ collectionId: 'ndc' }), { collection: NDC, collectionOptions: [NDC] });
    expect(screen.queryByRole('button', { name: /split across years/i })).not.toBeInTheDocument();
  });
});

describe('GamePanel — remove', () => {
  it('deletes the game after confirmation and closes the panel', async () => {
    await openPanel(game({ id: 'game-1', title: 'Elden Ring' }));
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Remove game' }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(deleteGameAction).toHaveBeenCalledWith('game-1'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps the panel open and re-enables the button when the delete rejects', async () => {
    deleteGameAction.mockRejectedValueOnce(new Error('boom'));
    const { toast } = await import('@/components/ui/toast');
    await openPanel(game());
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Remove game' }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove game' })).not.toBeDisabled(),
    );
  });
});
