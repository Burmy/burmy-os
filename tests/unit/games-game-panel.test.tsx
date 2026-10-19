import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ActionResult } from '@/features/games/action-result';
import { formatHours, hours } from '@/server/games/hours';
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

const completeWishlistGameAction = vi.fn(
  async (_id: string, _formData: FormData): Promise<ActionResult> => ({ ok: true }),
);
const createGameAction = vi.fn(async (_formData: FormData): Promise<ActionResult> => ({
  ok: true,
}));

vi.mock('@/features/games/game-actions', () => ({
  completeWishlistGameAction: (...args: [string, FormData]) => completeWishlistGameAction(...args),
  createGameAction: (...args: [FormData]) => createGameAction(...args),
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

const createGameDlcAction = vi.fn(
  async (_gameId: string, _formData: FormData): Promise<ActionResult> => ({ ok: true }),
);
const updateGameDlcAction = vi.fn(
  async (_dlcId: string, _formData: FormData): Promise<ActionResult> => ({ ok: true }),
);
const deleteGameDlcAction = vi.fn(async (_dlcId: string): Promise<ActionResult> => ({ ok: true }));

vi.mock('@/features/games/dlc-actions', () => ({
  createGameDlcAction: (...args: [string, FormData]) => createGameDlcAction(...args),
  updateGameDlcAction: (...args: [string, FormData]) => updateGameDlcAction(...args),
  deleteGameDlcAction: (...args: [string]) => deleteGameDlcAction(...args),
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
    hoursTenths: null,
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
    expect(
      await screen.findByRole('button', { name: 'Add games to collection' }),
    ).toBeInTheDocument();
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
    // `played` is the invisible default — the word never appears in the UI.
    expect(screen.queryByText('Played')).not.toBeInTheDocument();
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

  it('has no Status row at all', async () => {
    await openPanel(game({ status: 'played' }));

    expect(screen.queryByRole('button', { name: 'Status' })).not.toBeInTheDocument();
    expect(screen.queryByText('Status')).not.toBeInTheDocument();
  });

  it('a wanted game shows a Wanted pill and an Add to library button that opens the pre-filled dialog', async () => {
    await openPanel(game({ title: 'Silksong', status: 'wanted' }));
    const user = userEvent.setup();

    expect(screen.getByText('Wanted')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add to library' }));

    const heading = await screen.findByRole('heading', { name: 'Add to library' });
    expect(heading).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('Silksong');
  });

  it('saves the platinum toggle immediately, on and off', async () => {
    await openPanel(game({ platinum: false }));
    const user = userEvent.setup();

    const toggle = screen.getByRole('button', { name: 'Platinum', pressed: false });
    await user.click(toggle);
    await waitFor(() =>
      expect(updateGameFieldAction).toHaveBeenCalledWith('game-1', 'platinum', 'true'),
    );
  });

  it('turns platinum back off with an empty value', async () => {
    await openPanel(game({ platinum: true }));
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Platinum', pressed: true }));
    await waitFor(() =>
      expect(updateGameFieldAction).toHaveBeenCalledWith('game-1', 'platinum', ''),
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

    expect(screen.getByText('Uncharted 2: Among Thieves Remastered')).toBeInTheDocument();
    expect(screen.getAllByText('2 games').length).toBeGreaterThan(0);
    // A collection has no rating of its own (2026-10-19) — no Rating row.
    expect(screen.queryByText('Rating')).not.toBeInTheDocument();
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

  it('sums hours from the members, read-only, and drops the year rows for a rolled-up collection', async () => {
    await openPanel(game({ id: 'ndc', title: NDC.title, hoursTenths: 440 }), {
      members: [
        member({ id: 'uc1', hoursTenths: 97 }),
        member({ id: 'uc2', title: 'Uncharted 2: Among Thieves Remastered', hoursTenths: 133 }),
      ],
    });

    // 9.7 + 13.3 — the wrapper's own 44.0 is superseded, not added.
    expect(screen.getByText(formatHours(hours(230)))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hours' })).not.toBeInTheDocument();
    expect(
      screen.getAllByText('Added up from the games in this collection').length,
    ).toBeGreaterThan(0);
    // The members' hours are what would be split, so no year rows here.
    expect(screen.queryByRole('button', { name: 'Add a year' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'First played' })).toBeInTheDocument();
  });

  it('keeps an unsplit collection’s own hours editable while no member carries any', async () => {
    await openPanel(game({ id: 'ndc', title: NDC.title, hoursTenths: 440 }), {
      members: [member({ id: 'uc1' }), member({ id: 'uc2', title: 'Uncharted 2' })],
    });

    expect(screen.getByRole('button', { name: 'Hours' })).toBeInTheDocument();
    expect(
      screen.queryByText('Added up from the games in this collection'),
    ).not.toBeInTheDocument();
  });

  it('shows a member with its own editable hours, price read-only, and a Part of link that swaps to the collection', async () => {
    await openPanel(
      game({
        id: 'uc1',
        title: "Uncharted: Drake's Fortune Remastered",
        collectionId: 'ndc',
        hoursTenths: 97,
      }),
      {
        collection: NDC,
        collectionOptions: [NDC],
      },
    );
    const user = userEvent.setup();

    // Hours are the member's own — editable, with its year rows and DLC line.
    expect(screen.getByRole('button', { name: 'Hours' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a year' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add DLC' })).toBeInTheDocument();
    // Price is the set's.
    expect(screen.queryByRole('button', { name: 'Price paid' })).not.toBeInTheDocument();
    expect(screen.getAllByText('From the collection').length).toBeGreaterThan(0);
    expect(
      screen.queryByRole('button', { name: 'Add games to collection' }),
    ).not.toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: 'Add games to collection' }));
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

describe('GamePanel — years', () => {
  it('starts a split from the plus beside First played and saves once the years add up', async () => {
    await openPanel(game({ hoursTenths: 1360, firstPlayedYear: 2022 }));
    const user = userEvent.setup();

    expect(screen.queryByText('Years')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add a year' }));

    // The first year starts with all the hours; the new year is the next one
    // and waits for its hours, already in edit mode.
    expect(screen.getByText('Years')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Year 1' })).toHaveTextContent('2022');
    expect(screen.getByRole('button', { name: 'Hours in 2022' })).toHaveTextContent('136h');
    expect(screen.getByRole('button', { name: 'Year 2' })).toHaveTextContent('2023');
    await user.type(screen.getByRole('textbox', { name: 'Hours in 2023' }), '12{Enter}');

    // 136 + 12 is not 136 — nothing saves until the years add up.
    expect(screen.getByText('Years add up to 148h; hours are 136h')).toBeInTheDocument();
    expect(updateGamePlayYearsAction).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Hours in 2022' }));
    const first = screen.getByRole('textbox', { name: 'Hours in 2022' });
    await user.clear(first);
    await user.type(first, '124{Enter}');

    await waitFor(() => expect(updateGamePlayYearsAction).toHaveBeenCalledTimes(1));
    expect(updateGamePlayYearsAction.mock.calls[0]![1]).toEqual([
      { year: '2022', hours: '124', trophies: '' },
      { year: '2023', hours: '12', trophies: '' },
    ]);
    expect(screen.queryByText(/Years add up to/)).not.toBeInTheDocument();
  });

  it('lists an existing split as one row per year, with a remove on each and a plus on the last', async () => {
    await openPanel(
      game({
        hoursTenths: 490,
        firstPlayedYear: 2024,
        playYears: [
          { year: 2024, hoursTenths: 370, achievementsUnlocked: null },
          { year: 2025, hoursTenths: 120, achievementsUnlocked: null },
        ],
      }),
    );

    expect(screen.getByRole('button', { name: 'Hours in 2024' })).toHaveTextContent('37h');
    expect(screen.getByRole('button', { name: 'Hours in 2025' })).toHaveTextContent('12h');
    expect(screen.getByRole('button', { name: 'Remove 2024' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove 2025' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add a year' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /split across years/i })).not.toBeInTheDocument();
  });

  it('removing the only year clears the split', async () => {
    await openPanel(
      game({
        hoursTenths: 490,
        playYears: [{ year: 2024, hoursTenths: 490, achievementsUnlocked: null }],
      }),
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Remove 2024' }));

    await waitFor(() => expect(updateGamePlayYearsAction).toHaveBeenCalledWith('game-1', []));
  });

  it('gives a collection member its own year rows — its hours are its own (2026-10-19)', async () => {
    await openPanel(game({ collectionId: 'ndc', hoursTenths: 97 }), {
      collection: NDC,
      collectionOptions: [NDC],
    });
    expect(screen.getByRole('button', { name: 'Add a year' })).toBeInTheDocument();
  });
});

const DLC = {
  id: 'dlc-1',
  gameId: 'game-1',
  name: 'Shadow of the Erdtree',
  year: 2025,
  hoursTenths: 60,
  priceCents: 3999,
  achievementsUnlocked: 10,
  achievementsTotal: 12,
};

describe('GamePanel — polish', () => {
  it('shows the rating once: no stars in the header, the editable row stays', async () => {
    await openPanel(game({ rating: 5 }));

    expect(screen.queryByLabelText('5 out of 5')).not.toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(5);
  });

  it('has no section headings at all — Notes is a row like every other field', async () => {
    await openPanel(game());

    expect(screen.queryByText('Progress')).not.toBeInTheDocument();
    expect(screen.queryByText('Details')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Notes' })).not.toBeInTheDocument();
    const visible = screen
      .getAllByText('Notes')
      .filter((element) => !element.classList.contains('sr-only'));
    expect(visible).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Notes' })).toBeInTheDocument();
  });

  it('offers a plain + Add games to collection line on a standalone game — no toggle, no empty box', async () => {
    await openPanel(game());

    expect(screen.getByRole('button', { name: 'Add games to collection' })).toHaveTextContent(
      'Add games to collection',
    );
    expect(screen.queryByRole('button', { name: /collection$/ })).toBe(
      screen.getByRole('button', { name: 'Add games to collection' }),
    );
    expect(screen.queryByText(/Nothing in this collection/)).not.toBeInTheDocument();
    expect(screen.queryByText('Games in this collection')).not.toBeInTheDocument();
  });

  it('lists the members above that line, each with its own remove', async () => {
    await openPanel(game({ id: 'ndc', title: NDC.title }), { members: [member()] });

    expect(
      screen.getByRole('button', { name: "Uncharted: Drake's Fortune Remastered" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: `Remove Uncharted: Drake's Fortune Remastered from ${NDC.title}`,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add games to collection' })).toBeInTheDocument();
  });
});

describe('GamePanel — DLC', () => {
  it('with no DLC: editable rows, a plain Add DLC row, no grid, no "with DLC" text', async () => {
    await openPanel(game());

    expect(screen.getByRole('button', { name: 'Hours' })).toHaveTextContent('136h');
    expect(screen.getByRole('button', { name: 'Add DLC' })).toHaveTextContent('Add DLC');
    expect(screen.queryByText('Base game')).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Hours' })).not.toBeInTheDocument();
    expect(screen.queryByText(/with DLC/)).not.toBeInTheDocument();
  });

  it('with DLC: totals read-only in the rows, and a labelled grid — parts down, figures across', async () => {
    await openPanel(game({ dlc: [DLC] }));

    expect(screen.queryByRole('button', { name: 'Hours' })).not.toBeInTheDocument();
    expect(screen.getByText('142h')).toBeInTheDocument();
    expect(screen.getByText('$105.64')).toBeInTheDocument();
    expect(screen.queryByText(/with DLC/)).not.toBeInTheDocument();

    for (const column of ['Year', 'Hours', 'Price', 'Trophies']) {
      expect(screen.getByRole('columnheader', { name: column })).toBeInTheDocument();
    }
    expect(screen.getByText('Base game')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Base game: hours' })).toHaveTextContent('136h');
    expect(screen.getByRole('button', { name: 'Base game: price' })).toHaveTextContent('$65.65');
    expect(screen.getByRole('button', { name: 'Shadow of the Erdtree: name' })).toHaveTextContent(
      'Shadow of the Erdtree',
    );
    expect(screen.getByRole('button', { name: 'Shadow of the Erdtree: year' })).toHaveTextContent(
      '2025',
    );
    expect(screen.getByRole('button', { name: 'Shadow of the Erdtree: hours' })).toHaveTextContent(
      '6h',
    );
    expect(
      screen.getByRole('button', { name: 'Shadow of the Erdtree: trophies earned' }),
    ).toHaveTextContent('10');
    // No box around the grid, no modal anywhere: every cell edits in place.
    expect(screen.queryByRole('dialog', { name: 'Shadow of the Erdtree' })).not.toBeInTheDocument();
  });

  it('the Base game row shows the First played year, and editing it saves firstPlayedYear', async () => {
    await openPanel(game({ dlc: [DLC], firstPlayedYear: 2022 }));
    const user = userEvent.setup();

    expect(screen.getByRole('button', { name: 'Base game: year' })).toHaveTextContent('2022');
    await user.click(screen.getByRole('button', { name: 'Base game: year' }));
    const input = screen.getByRole('textbox', { name: 'Base game: year' });
    await user.clear(input);
    await user.type(input, '2023{Enter}');

    await waitFor(() =>
      expect(updateGameFieldAction).toHaveBeenCalledWith('game-1', 'firstPlayedYear', '2023'),
    );
  });

  it('offers Add DLC on a collection member — its hours, and so its DLC, are its own (2026-10-19)', async () => {
    await openPanel(game({ id: 'uc1', collectionId: 'ndc' }), {
      collection: NDC,
      collectionOptions: [NDC],
    });

    expect(screen.getByRole('button', { name: 'Add DLC' })).toBeInTheDocument();
  });

  it('Add DLC adds an inline row: name and year, saved in place', async () => {
    await openPanel(game());
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Add DLC' }));
    expect(screen.queryByRole('dialog', { name: 'Add DLC' })).not.toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'New DLC name' }), 'Elden DLC');
    await user.type(screen.getByRole('textbox', { name: 'New DLC year' }), '2026');
    await user.click(screen.getByRole('button', { name: 'Save new DLC' }));

    await waitFor(() => expect(createGameDlcAction).toHaveBeenCalledTimes(1));
    const [gameId, formData] = createGameDlcAction.mock.calls[0]!;
    expect(gameId).toBe('game-1');
    expect(formData.get('name')).toBe('Elden DLC');
    expect(formData.get('year')).toBe('2026');
    await waitFor(() => expect(getGamePanelAction).toHaveBeenCalledTimes(2));
  });

  it('editing one DLC cell saves the whole row with that cell changed', async () => {
    await openPanel(game({ dlc: [DLC] }));
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Shadow of the Erdtree: hours' }));
    const input = screen.getByRole('textbox', { name: 'Shadow of the Erdtree: hours' });
    await user.clear(input);
    await user.type(input, '7{Enter}');

    await waitFor(() => expect(updateGameDlcAction).toHaveBeenCalledTimes(1));
    const [dlcId, formData] = updateGameDlcAction.mock.calls[0]!;
    expect(dlcId).toBe('dlc-1');
    expect(formData.get('name')).toBe('Shadow of the Erdtree');
    expect(formData.get('year')).toBe('2025');
    expect(formData.get('hours')).toBe('7');
    expect(formData.get('priceDollars')).toBe('39.99');
    expect(formData.get('achievementsUnlocked')).toBe('10');
    expect(formData.get('achievementsTotal')).toBe('12');
  });

  it('editing a Base game cell goes through the ordinary field action', async () => {
    await openPanel(game({ dlc: [DLC] }));
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Base game: hours' }));
    const input = screen.getByRole('textbox', { name: 'Base game: hours' });
    await user.clear(input);
    await user.type(input, '140{Enter}');

    await waitFor(() =>
      expect(updateGameFieldAction).toHaveBeenCalledWith('game-1', 'hours', '140'),
    );
  });

  it('removing a DLC confirms, then calls deleteGameDlcAction', async () => {
    await openPanel(game({ dlc: [DLC] }));
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Remove Shadow of the Erdtree' }));
    await user.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(deleteGameDlcAction).toHaveBeenCalledWith('dlc-1'));
  });
});

describe("GamePanel — a collection's DLC trophies", () => {
  it('adds the DLC on top of the member roll-up in the read-only rows', async () => {
    // Members carry 30/40 + 10/20 = 40/60; the DLC adds 10/12 → 50/72. The
    // wrapper's own stale stored counts (42/42) must play no part.
    await openPanel(
      game({
        id: 'ndc',
        title: NDC.title,
        dlc: [{ ...DLC, gameId: 'ndc', achievementsUnlocked: 10, achievementsTotal: 12 }],
      }),
      {
        members: [
          member({ id: 'uc1', achievementsUnlocked: 30, achievementsTotal: 40 }),
          member({
            id: 'uc2',
            title: 'Uncharted 2',
            achievementsUnlocked: 10,
            achievementsTotal: 20,
          }),
        ],
      },
    );

    expect(screen.getByText('50')).toBeInTheDocument();
    expect(screen.getByText('72')).toBeInTheDocument();
    expect(screen.queryByText('52')).not.toBeInTheDocument();
  });
});
