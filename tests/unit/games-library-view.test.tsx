import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const deleteGameAction = vi.fn(async () => ({ ok: true as const }));
const createGameAction = vi.fn(async () => ({ ok: true as const }));
const reorderLibraryAction = vi.fn(async () => ({ ok: true as const }));
const resetLibraryOrderAction = vi.fn(async () => ({ ok: true as const }));

vi.mock('@/features/games/game-actions', () => ({
  deleteGameAction,
  createGameAction,
  reorderLibraryAction,
  resetLibraryOrderAction,
}));

vi.mock('@/features/games/metadata-actions', () => ({
  searchGameMetadataAction: vi.fn(async () => []),
}));

vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Opening a game shows the side panel (see `game-panel.tsx`); `LibraryView`
// reaches it through `useGamePanel()`, mocked here so the view renders
// without the provider the Games layout normally supplies.
const openGame = vi.fn();
vi.mock('@/features/games/panel/game-panel-context', () => ({
  useGamePanel: () => ({ openGame, close: vi.fn(), activeId: null }),
}));

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

/**
 * The gallery renders NO visible text — a card is bare box art now (see
 * `game-card.tsx`). So "is this game on screen?" can no longer be answered
 * with `getByText(title)`; the title lives only in each card's `aria-label`,
 * formatted as `"<title>[ — Wanted][ — Platinum]"`.
 *
 * This reads the gallery the way a screen reader would, which is also the only
 * way left to read it. Table view still renders real text and its tests still
 * use `getByText` directly.
 */
function galleryTitles(): string[] {
  // A card is the only button in the gallery with a native `title` (the
  // tooltip that recovers an unrecognised cover); its `aria-label` is the
  // title, followed by " — Wanted" / " — Platinum" / " — collection of N"
  // only when those apply — a played game is named by its title alone.
  return screen
    .getAllByRole('button')
    .filter((button) => button.hasAttribute('title'))
    .map((button) => (button.getAttribute('aria-label') ?? '').split(' — ')[0]!);
}

describe('LibraryView', () => {
  it('renders every game in the default gallery view', () => {
    render(
      <LibraryView
        games={[game({ id: 'a', title: 'Elden Ring' }), game({ id: 'b', title: 'Prey' })]}
      />,
    );

    expect(galleryTitles()).toEqual(['Elden Ring', 'Prey']);
  });

  it('switches to a table view without losing any games', async () => {
    render(<LibraryView games={[game({ id: 'a', title: 'Elden Ring' })]} />);

    await userEvent.click(screen.getByRole('button', { name: /^table$/i }));

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('Elden Ring')).toBeInTheDocument();
  });

  it('opens the panel from the table view by keyboard, not just by clicking the row', async () => {
    openGame.mockClear();
    render(<LibraryView games={[game({ id: 'a', title: 'Elden Ring' })]} />);

    await userEvent.click(screen.getByRole('button', { name: /^table$/i }));

    // The row itself is not a focusable control — a real button inside the
    // title cell is, so this is what tab order actually lands on.
    screen.getByRole('button', { name: 'Elden Ring' }).focus();
    await userEvent.keyboard('{Enter}');

    expect(openGame).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
  });

  it('filters by status', async () => {
    render(
      <LibraryView
        games={[
          game({ id: 'a', title: 'Finished Game', status: 'played' }),
          game({ id: 'b', title: 'Wanted Game', status: 'wanted' }),
        ]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /^wanted/i }));

    expect(galleryTitles()).toEqual(['Wanted Game']);
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

    expect(galleryTitles()).toEqual(['Desktop Game']);
  });

  it('combines status and platform filters', async () => {
    render(
      <LibraryView
        games={[
          game({ id: 'a', title: 'Match', status: 'wanted', platform: 'steam' }),
          game({ id: 'b', title: 'Wrong status', status: 'played', platform: 'steam' }),
          game({ id: 'c', title: 'Wrong platform', status: 'wanted', platform: 'ps5' }),
        ]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /^wanted/i }));
    await userEvent.click(screen.getByRole('button', { name: /^steam \/ pc/i }));

    expect(galleryTitles()).toEqual(['Match']);
  });

  it('shows a searchable count that reflects the active filter', async () => {
    render(
      <LibraryView
        games={[
          game({ id: 'a', title: 'Finished Game', status: 'played' }),
          game({ id: 'b', title: 'Queued Game', status: 'played' }),
        ]}
      />,
    );

    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'Queued');

    expect(galleryTitles()).toEqual(['Queued Game']);
    expect(screen.getByText('1 of 2 games')).toBeInTheDocument();
  });

  it('does not render a platform filter chip for a platform with zero games', () => {
    render(<LibraryView games={[game({ id: 'a', platform: 'ps5' })]} />);

    expect(screen.getByRole('button', { name: /^ps5/i })).toBeInTheDocument();
    // steam, psp, pc, other all have zero games in this library — none of
    // their chips should exist at all, not just be inactive.
    expect(screen.queryByRole('button', { name: /^steam/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^psp/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^pc/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^other/i })).not.toBeInTheDocument();
  });

  it('does not render the wanted chip when nothing is wishlisted', () => {
    render(<LibraryView games={[game({ id: 'a', status: 'played' })]} />);

    expect(screen.queryByRole('button', { name: /^wanted/i })).not.toBeInTheDocument();
  });

  /**
   * `wanted` is the ONLY status that earns a chip. `played` is the default for
   * ~95% of the library and `playing` covers at most one game, so neither is a
   * useful library-wide filter; `backlog` had a chip until real use showed it
   * wasn't a bucket the owner actually filtered by.
   *
   * Every status below has a nonzero count on purpose — otherwise this would
   * pass for the wrong reason (the zero-count filter suppressing them anyway).
   */
  it('renders wanted as the only status chip, whatever the other counts are', () => {
    render(
      <LibraryView
        games={[game({ id: 'a', status: 'played' }), game({ id: 'd', status: 'wanted' })]}
      />,
    );

    expect(screen.getByRole('button', { name: /^wanted/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^played/i })).not.toBeInTheDocument();
  });

  it('labels the steam platform chip "Steam / PC"', () => {
    render(<LibraryView games={[game({ id: 'a', platform: 'steam' })]} />);
    expect(screen.getByRole('button', { name: /^steam \/ pc/i })).toBeInTheDocument();
  });

  /**
   * The three "All …" chips were removed — they spent permanent slots
   * restating a total the header already prints, and one of them headed a
   * Source group whose "Steam" chip meant something different from the
   * "Steam / PC" platform chip beside it. Clearing a filter now happens by
   * toggling the active chip, or via a "Clear" that appears only while
   * something is filtered.
   */
  it('clears a filter when its own active chip is clicked again', async () => {
    render(
      <LibraryView
        games={[
          game({ id: 'a', title: 'Astro Bot', platform: 'ps5' }),
          game({ id: 'b', title: 'Daxter', platform: 'psp' }),
        ]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /^PS5, \d/i }));
    expect(galleryTitles()).not.toContain('Daxter');

    await userEvent.click(screen.getByRole('button', { name: /^PS5, \d/i }));
    expect(galleryTitles()).toContain('Daxter');
  });

  it('offers Clear only while something is actually filtered', async () => {
    render(
      <LibraryView
        games={[game({ id: 'a', platform: 'ps5' }), game({ id: 'b', platform: 'psp' })]}
      />,
    );

    expect(screen.queryByRole('button', { name: /^clear$/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^PS5, \d/i }));
    await userEvent.click(screen.getByRole('button', { name: /^clear$/i }));

    expect(screen.queryByRole('button', { name: /^clear$/i })).not.toBeInTheDocument();
    expect(screen.getByText('2 games')).toBeInTheDocument();
  });

  it('tells the owner the library is empty rather than rendering a blank grid', () => {
    render(<LibraryView games={[]} />);
    expect(screen.getByText(/no games yet/i)).toBeInTheDocument();
  });

  /**
   * Asserted through TABLE view, not the gallery: the gallery card is bare box
   * art now and renders no hours — or any other text — at all. The formatting
   * contract this guards (tenths in the column, hours on screen) is unchanged;
   * only the surface that still displays it has moved.
   */
  it('formats hours as the owner writes them, not as raw tenths', async () => {
    render(<LibraryView games={[game({ hoursTenths: 1360, platform: 'ps5' })]} />);

    await userEvent.click(screen.getByRole('button', { name: /^table$/i }));

    expect(screen.getByText(/\b136h\b/)).toBeInTheDocument();
    expect(screen.queryByText(/1360/)).not.toBeInTheDocument();
  });

  /**
   * "Upcoming games" plan, Task 5: `wanted` (wishlist) rows are hidden from
   * the default view and revealed only by their own status chip — see
   * `library-view.tsx`'s `nonWantedGames` comment for the full reasoning.
   */
  describe('wanted (wishlist) games', () => {
    it('hides wanted games from the default gallery view', () => {
      render(
        <LibraryView
          games={[
            game({ id: 'a', title: 'Owned Game', status: 'played' }),
            game({ id: 'b', title: 'Wishlisted Game', status: 'wanted' }),
          ]}
        />,
      );

      expect(galleryTitles()).toEqual(['Owned Game']);
    });

    it('reveals wanted games only once their own status chip is active', async () => {
      render(
        <LibraryView
          games={[
            game({ id: 'a', title: 'Owned Game', status: 'played' }),
            game({ id: 'b', title: 'Wishlisted Game', status: 'wanted' }),
          ]}
        />,
      );

      await userEvent.click(screen.getByRole('button', { name: /^wanted/i }));

      expect(galleryTitles()).toEqual(['Wishlisted Game']);
    });

    it('does not count wanted games in the platform chips or the header total', () => {
      render(
        <LibraryView
          games={[
            game({ id: 'a', title: 'Owned Game', status: 'played', platform: 'ps5' }),
            game({ id: 'b', title: 'Wishlisted Game', status: 'wanted', platform: 'ps5' }),
          ]}
        />,
      );

      // "1 game" — the wishlist entry must not inflate the total.
      expect(screen.getByText('1 game')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^ps5/i })).toHaveTextContent('PS51');
    });

    it("the Wanted chip's own count is unaffected by being excluded from every other chip", () => {
      render(
        <LibraryView
          games={[
            game({ id: 'a', status: 'played' }),
            game({ id: 'b', status: 'wanted' }),
            game({ id: 'c', status: 'wanted' }),
          ]}
        />,
      );

      expect(screen.getByRole('button', { name: /^wanted/i })).toHaveTextContent('Wanted2');
    });
  });
});

/**
 * Year, Rating and Sort (2026-10-19), and the drag that lives in My order.
 * A card is draggable exactly when the owner is in My order with nothing
 * filtered — dnd-kit marks a sortable activator with
 * `aria-roledescription="sortable"`, which is the one observable fact jsdom
 * can confirm (the drag itself needs layout and is checked in a real
 * browser).
 */
describe('LibraryView — order, sort and the newer filters', () => {
  const library = [
    game({ id: 'a', title: 'Alpha', firstPlayedYear: 2024, rating: 5, hoursTenths: 100 }),
    game({ id: 'b', title: 'Bravo', firstPlayedYear: 2022, rating: 3, hoursTenths: 900 }),
    game({ id: 'c', title: 'Charlie', firstPlayedYear: null, rating: null, hoursTenths: 500 }),
  ];
  const cardTitles = () =>
    screen
      .getAllByRole('button', { name: /^(Alpha|Bravo|Charlie)/ })
      .map((el) => el.getAttribute('aria-label'));

  async function choose(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
    await user.click(screen.getByRole('combobox', { name: label }));
    await user.click(await screen.findByRole('option', { name: option }));
  }

  it('filters by first-played year, including the retro rows with none', async () => {
    render(<LibraryView games={library} />);
    const user = userEvent.setup();

    await choose(user, 'Year', '2024');
    expect(cardTitles()).toEqual(['Alpha']);

    await choose(user, 'Year', 'No year');
    expect(cardTitles()).toEqual(['Charlie']);
  });

  it('filters by minimum rating and by "Unrated"', async () => {
    render(<LibraryView games={library} />);
    const user = userEvent.setup();

    await choose(user, 'Rating', '4+ stars');
    expect(cardTitles()).toEqual(['Alpha']);

    await choose(user, 'Rating', 'Unrated');
    expect(cardTitles()).toEqual(['Charlie']);
  });

  it('sorts by hours without touching the order the data came in', async () => {
    render(<LibraryView games={library} />);
    const user = userEvent.setup();

    expect(cardTitles()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    await choose(user, 'Sort', 'Hours');
    expect(cardTitles()).toEqual(['Bravo', 'Charlie', 'Alpha']);
    expect(reorderLibraryAction).not.toHaveBeenCalled();
  });

  it('makes cards draggable only in My order with nothing filtered', async () => {
    render(<LibraryView games={library} />);
    const user = userEvent.setup();
    const sortableCards = () =>
      screen
        .getAllByRole('button', { name: /^(Alpha|Bravo|Charlie)/ })
        .filter((el) => el.getAttribute('aria-roledescription') === 'sortable');

    expect(sortableCards()).toHaveLength(3);
    expect(screen.queryByText('Clear the filters to reorder.')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^PS5/ }));
    expect(sortableCards()).toHaveLength(0);
    expect(screen.getByText('Clear the filters to reorder.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await choose(user, 'Sort', 'Title');
    expect(sortableCards()).toHaveLength(0);
    // Not a filter, so no hint — the Sort select itself says why.
    expect(screen.queryByText('Clear the filters to reorder.')).not.toBeInTheDocument();
  });

  it('asks before resetting the order, then calls the action', async () => {
    render(<LibraryView games={library} customOrder />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Reset order' }));
    const dialog = await screen.findByRole('dialog');
    expect(resetLibraryOrderAction).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Reset order' }));
    await waitFor(() => expect(resetLibraryOrderAction).toHaveBeenCalledTimes(1));
  });

  it('offers Reset order only once something has been placed by hand, and only in My order', async () => {
    const { rerender } = render(<LibraryView games={library} />);
    const user = userEvent.setup();
    expect(screen.queryByRole('button', { name: 'Reset order' })).not.toBeInTheDocument();

    rerender(<LibraryView games={library} customOrder />);
    expect(screen.getByRole('button', { name: 'Reset order' })).toBeInTheDocument();

    await choose(user, 'Sort', 'Year');
    expect(screen.queryByRole('button', { name: 'Reset order' })).not.toBeInTheDocument();
  });
});
