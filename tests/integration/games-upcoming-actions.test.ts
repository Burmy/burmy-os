import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { harness, provisionOwner, resetDatabase } from './harness';

/**
 * The "Upcoming games" wishlist Server Action path
 * (`src/features/games/upcoming/wishlist-actions.ts`) end to end, against a
 * real Postgres — not just the DAL functions it calls directly (that is
 * `tests/integration/games.test.ts`'s job, in its own "Upcoming games /
 * wishlist" section).
 *
 * Same mocking rationale as `games-actions.test.ts`: `requireOwner()` reads
 * `next/headers`, which needs Next's request-scoped storage that doesn't
 * exist in a Vitest worker, so it's swapped for a plain resolved `Headers`
 * object; `revalidatePath()` needs Next's work-scoped async storage too, so
 * it's stubbed to a no-op — this suite is about what the action WROTE to the
 * database, not Next's own cache invalidation.
 */

const requestHeaders = { current: new Headers() };

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(requestHeaders.current),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

type WishlistActions = typeof import('@/features/games/upcoming/wishlist-actions');
type Games = typeof import('@/server/db/games/games');

let actions: WishlistActions;
let games: Games;

beforeAll(async () => {
  await harness();
  [actions, games] = await Promise.all([
    import('@/features/games/upcoming/wishlist-actions'),
    import('@/server/db/games/games'),
  ]);
});

beforeEach(async () => {
  await resetDatabase();
  requestHeaders.current = new Headers();
});

function wishlistInput(overrides: Partial<Parameters<typeof actions.addToWishlistAction>[0]> = {}): Parameters<
  typeof actions.addToWishlistAction
>[0] {
  return {
    igdbId: 92550,
    title: 'Fable',
    coverUrl: 'https://images.igdb.com/igdb/image/upload/t_cover_big_2x/cobc6d.jpg',
    releaseDate: '2027-02-01',
    releasePrecision: null,
    platforms: ['ps5'],
    ...overrides,
  };
}

describe('addToWishlistAction', () => {
  it('round-trips: creates a wanted row the owner can then fetch', async () => {
    const ownerId = await provisionOwner();

    const result = await actions.addToWishlistAction(wishlistInput());

    expect(result.ok).toBe(true);
    const created = await games.listGames(ownerId, { status: 'wanted' });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ title: 'Fable', status: 'wanted', platform: 'ps5' });
  });

  it('defaults to the steam platform when the candidate does not list PS5', async () => {
    const ownerId = await provisionOwner();

    const result = await actions.addToWishlistAction(wishlistInput({ igdbId: 5, platforms: ['pc'] }));

    expect(result.ok).toBe(true);
    const [created] = await games.listGames(ownerId, { status: 'wanted' });
    expect(created?.platform).toBe('steam');
  });

  it('rejects a duplicate igdbId as a clean field error, not a thrown 500', async () => {
    const ownerId = await provisionOwner();
    await actions.addToWishlistAction(wishlistInput());

    const result = await actions.addToWishlistAction(wishlistInput({ title: 'Fable (again)' }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/already in your library/i);
    // Still exactly one row — the rejected attempt inserted nothing.
    expect(await games.listGames(ownerId, { status: 'wanted' })).toHaveLength(1);
  });

  it('scopes the created row to the resolved owner — never visible to another owner', async () => {
    const ownerId = await provisionOwner();
    const otherOwnerId = await provisionOwner('someone-else@burmy.test');

    await actions.addToWishlistAction(wishlistInput());

    expect(await games.listGames(ownerId, { status: 'wanted' })).toHaveLength(1);
    expect(await games.listGames(otherOwnerId, { status: 'wanted' })).toHaveLength(0);
  });
});

describe('promoteReleasedWantedGamesAction', () => {
  it('flips only overdue wanted rows to backlog', async () => {
    const ownerId = await provisionOwner();
    const overdue = await games.createWishlistGame(ownerId, {
      igdbId: 1,
      title: 'Overdue',
      coverUrl: null,
      releaseDate: '2020-01-01',
      releasePrecision: null,
      platform: 'ps5',
    });
    const future = await games.createWishlistGame(ownerId, {
      igdbId: 2,
      title: 'Future',
      coverUrl: null,
      releaseDate: '2099-01-01',
      releasePrecision: null,
      platform: 'ps5',
    });

    const result = await actions.promoteReleasedWantedGamesAction();

    expect(result.ok).toBe(true);
    expect((await games.getGame(ownerId, overdue.id)).status).toBe('backlog');
    expect((await games.getGame(ownerId, future.id)).status).toBe('wanted');
  });

  it("only flips the resolved owner's rows, never another owner's", async () => {
    const ownerId = await provisionOwner();
    const otherOwnerId = await provisionOwner('someone-else@burmy.test');
    const theirOverdue = await games.createWishlistGame(otherOwnerId, {
      igdbId: 3,
      title: 'Their overdue game',
      coverUrl: null,
      releaseDate: '2020-01-01',
      releasePrecision: null,
      platform: 'ps5',
    });

    await actions.promoteReleasedWantedGamesAction();

    expect((await games.getGame(otherOwnerId, theirOverdue.id)).status).toBe('wanted');
    // Sanity: the resolved owner had nothing to flip, and the action still
    // succeeded rather than erroring on an empty update.
    expect(await games.listGames(ownerId, { status: 'wanted' })).toHaveLength(0);
  });

  it('is idempotent — calling it again after everything is already flipped succeeds and changes nothing further', async () => {
    const ownerId = await provisionOwner();
    const overdue = await games.createWishlistGame(ownerId, {
      igdbId: 1,
      title: 'Overdue',
      coverUrl: null,
      releaseDate: '2020-01-01',
      releasePrecision: null,
      platform: 'ps5',
    });

    const first = await actions.promoteReleasedWantedGamesAction();
    const second = await actions.promoteReleasedWantedGamesAction();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect((await games.getGame(ownerId, overdue.id)).status).toBe('backlog');
  });
});

/**
 * The reconcile exists because a wishlist row is stamped with IGDB's date at
 * the moment it is added and then never revisited. Two things go wrong with
 * that: every row added before the query started requesting `release_dates.d`
 * holds a `-01` PLACEHOLDER day and so can never count down, and a game that
 * slips from November to March advertises November forever.
 */
describe('reconcileWishlistReleaseDatesAction', () => {
  it('upgrades a stored month-precision placeholder to a real day', async () => {
    const ownerId = await provisionOwner();
    const game = await games.createWishlistGame(ownerId, {
      igdbId: 42,
      title: "Marvel's Wolverine",
      coverUrl: null,
      releaseDate: '2026-09-01',
      releasePrecision: 'month',
      platform: 'ps5',
    });

    const result = await actions.reconcileWishlistReleaseDatesAction([
      { igdbId: 42, releaseDate: '2026-09-18', releasePrecision: 'day' },
    ]);

    expect(result.ok).toBe(true);
    const fetched = await games.getGame(ownerId, game.id);
    expect(fetched.releaseDate).toBe('2026-09-18');
    expect(fetched.releasePrecision).toBe('day');
  });

  it('follows a genuine delay, not just a precision upgrade', async () => {
    const ownerId = await provisionOwner();
    const game = await games.createWishlistGame(ownerId, {
      igdbId: 7,
      title: 'Slipped Game',
      coverUrl: null,
      releaseDate: '2026-11-20',
      releasePrecision: 'day',
      platform: 'ps5',
    });

    await actions.reconcileWishlistReleaseDatesAction([
      { igdbId: 7, releaseDate: '2027-03-12', releasePrecision: 'day' },
    ]);

    expect((await games.getGame(ownerId, game.id)).releaseDate).toBe('2027-03-12');
  });

  /**
   * A game IGDB genuinely only knows the month of (GTA VI is "November 2026",
   * full stop) must keep saying so. Writing a day here would invent a launch
   * date, which is the entire reason precision is stored rather than inferred.
   */
  it('leaves a still-month-precision reading exactly as it was', async () => {
    const ownerId = await provisionOwner();
    const game = await games.createWishlistGame(ownerId, {
      igdbId: 99,
      title: 'Grand Theft Auto VI',
      coverUrl: null,
      releaseDate: '2026-11-01',
      releasePrecision: 'month',
      platform: 'ps5',
    });

    await actions.reconcileWishlistReleaseDatesAction([
      { igdbId: 99, releaseDate: '2026-11-01', releasePrecision: 'month' },
    ]);

    const fetched = await games.getGame(ownerId, game.id);
    expect(fetched.releaseDate).toBe('2026-11-01');
    expect(fetched.releasePrecision).toBe('month');
  });

  /**
   * `fetchUpcomingGames()` returns `[]` for a MISSING CREDENTIAL and for a
   * FAILED REQUEST alike (see `igdbConfigured()`'s own doc comment), so a
   * reading with no date can mean "IGDB did not answer." Treating that as
   * truth would erase every stored date the owner is waiting on.
   */
  it('never nulls a stored date from a reading that carries none', async () => {
    const ownerId = await provisionOwner();
    const game = await games.createWishlistGame(ownerId, {
      igdbId: 5,
      title: 'Still Dated',
      coverUrl: null,
      releaseDate: '2026-12-04',
      releasePrecision: 'day',
      platform: 'ps5',
    });

    await actions.reconcileWishlistReleaseDatesAction([
      { igdbId: 5, releaseDate: null, releasePrecision: null },
    ]);

    expect((await games.getGame(ownerId, game.id)).releaseDate).toBe('2026-12-04');
  });

  /**
   * A game the owner has since marked owned is no longer a wishlist row, and a
   * background reconcile they never asked to run must not rewrite its data.
   * Enforced in `updateWantedReleaseDate`'s own WHERE clause, not merely at
   * the call site — this proves the DAL guard, not the caller's filter.
   */
  it('does not touch a game that has been promoted out of the wishlist', async () => {
    const ownerId = await provisionOwner();
    const game = await games.createWishlistGame(ownerId, {
      igdbId: 11,
      title: 'Since Released',
      coverUrl: null,
      releaseDate: '2026-01-01',
      releasePrecision: 'month',
      platform: 'ps5',
    });
    await games.updateGame(ownerId, game.id, { title: game.title, platform: 'ps5', status: 'backlog' });

    await actions.reconcileWishlistReleaseDatesAction([
      { igdbId: 11, releaseDate: '2026-01-22', releasePrecision: 'day' },
    ]);

    expect((await games.getGame(ownerId, game.id)).releaseDate).toBe('2026-01-01');
  });

  it('never reaches across owners', async () => {
    // Provisioned first so it is the owner `requireOwner()` resolves to; its
    // own wishlist stays empty, which is the point.
    await provisionOwner();
    const otherOwnerId = await provisionOwner('someone-else@burmy.test');
    const theirs = await games.createWishlistGame(otherOwnerId, {
      igdbId: 77,
      title: 'Theirs',
      coverUrl: null,
      releaseDate: '2026-10-01',
      releasePrecision: 'month',
      platform: 'ps5',
    });

    // Acting as `ownerId`, whose own wishlist is empty.
    await actions.reconcileWishlistReleaseDatesAction([
      { igdbId: 77, releaseDate: '2026-10-15', releasePrecision: 'day' },
    ]);

    expect((await games.getGame(otherOwnerId, theirs.id)).releaseDate).toBe('2026-10-01');
  });
});
