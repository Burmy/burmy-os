import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { harness, resetDatabase } from './harness';

/**
 * The owner-scoped games data-access layer, against a real PostgreSQL 18.
 *
 * These are integration tests rather than unit tests because the behaviour
 * being verified belongs to the DATABASE: the partial unique index on
 * (owner_id, lower(title), platform), owner scoping in every WHERE, and the
 * cascade from `user`. A mocked client would only prove the mock matches my
 * assumptions about Postgres, which is the assumption most worth testing.
 */

type Games = typeof import('@/server/db/games/games');
type Errors = typeof import('@/server/db/games/errors');
type PlayYearsDb = typeof import('@/server/db/games/play-years');

let games: Games;
let errors: Errors;
let playYearsDb: PlayYearsDb;

beforeAll(async () => {
  await harness();
  [games, errors, playYearsDb] = await Promise.all([
    import('@/server/db/games/games'),
    import('@/server/db/games/errors'),
    import('@/server/db/games/play-years'),
  ]);
});

beforeEach(async () => {
  await resetDatabase();
});

/** Create a user row directly — this suite is about games data, not auth. */
async function makeOwner(email: string): Promise<string> {
  const { sql } = await harness();
  const { randomUUID } = await import('node:crypto');
  const id = randomUUID();
  await sql`
    insert into "user" ("id", "name", "email", "email_verified")
    values (${id}, ${email}, ${email}, true)
  `;
  return id;
}

describe('createGame', () => {
  it('creates a game with only a title and platform, leaving everything else null', async () => {
    const owner = await makeOwner('owner@burmy.test');

    const created = await games.createGame(owner, { title: 'Bloodborne', platform: 'ps4' });

    expect(created.title).toBe('Bloodborne');
    expect(created.status).toBe('played');
    expect(created.hoursTenths).toBeNull();
    expect(created.rating).toBeNull();
  });

  it('rejects the same title twice on one platform', async () => {
    const owner = await makeOwner('owner@burmy.test');
    await games.createGame(owner, { title: 'Elden Ring', platform: 'ps5' });

    await expect(
      games.createGame(owner, { title: 'elden ring', platform: 'ps5' }),
    ).rejects.toBeInstanceOf(errors.DuplicateGameError);
  });

  it('allows the same title on a DIFFERENT platform — a real replay, not a duplicate', async () => {
    const owner = await makeOwner('owner@burmy.test');
    await games.createGame(owner, { title: 'Elden Ring', platform: 'ps4' });

    const onPs5 = await games.createGame(owner, { title: 'Elden Ring', platform: 'ps5' });
    expect(onPs5.platform).toBe('ps5');
  });
});

describe('updateGame', () => {
  it('updates the fields given and refreshes updated_at', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const created = await games.createGame(owner, { title: 'Prey', platform: 'ps5' });

    // updatedAt is set from a JS clock; without a beat between the two writes the
    // create and update can land in the same millisecond and a strict comparison
    // would flake. 5ms costs nothing in a suite that already runs against a container.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const updated = await games.updateGame(owner, created.id, {
      title: 'Prey',
      platform: 'ps5',
      status: 'played',
      hoursTenths: 240,
      rating: 3,
    });

    expect(updated.status).toBe('played');
    expect(updated.hoursTenths).toBe(240);
    // Strict: proves updateGame's manual `updatedAt: new Date()` actually ran.
    // A dropped manual set would leave this byte-identical to created.updatedAt,
    // which `toBeGreaterThanOrEqual` would have let pass silently.
    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
  });

  it('throws GameNotFoundError for an id that does not exist', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const { randomUUID } = await import('node:crypto');

    await expect(
      games.updateGame(owner, randomUUID(), { title: 'Nope', platform: 'ps5' }),
    ).rejects.toBeInstanceOf(errors.GameNotFoundError);
  });

  /**
   * Regression for the M12 fix-wave bug: the editor could set an optional
   * field but never clear one. `text()` in `game-actions.ts` maps a blanked
   * form field to `undefined`, and `parse()` used to OMIT that key from the
   * update input regardless — an omitted key is absent from Drizzle's `.set()`
   * clause, so the column was silently left untouched. Rate a game 5, clear
   * the box, save: the toast said "Game updated" and the value stayed 5.
   *
   * This exercises the DAL directly (the layer `updateGame` at games.ts:141
   * actually writes), asserting that an update whose input carries an
   * EXPLICIT `null` — the shape the fixed `parse()` now produces for a
   * cleared field — really does null the column out, not merely leave it
   * alone the way an omitted key would.
   */
  it('clears a previously-set optional field to null when the input explicitly says null', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const created = await games.createGame(owner, {
      title: 'Persona 5 Royal',
      platform: 'ps5',
      rating: 5,
      hoursTenths: 1200,
      notes: 'New Game+ is worth it',
      developer: 'Atlus',
    });
    expect(created.rating).toBe(5);
    expect(created.hoursTenths).toBe(1200);
    expect(created.notes).toBe('New Game+ is worth it');
    expect(created.developer).toBe('Atlus');

    const cleared = await games.updateGame(owner, created.id, {
      title: created.title,
      platform: created.platform,
      rating: null,
      hoursTenths: null,
      notes: null,
      developer: null,
    });

    expect(cleared.rating).toBeNull();
    expect(cleared.hoursTenths).toBeNull();
    expect(cleared.notes).toBeNull();
    expect(cleared.developer).toBeNull();
  });
});

describe('deleteGame', () => {
  it('removes the row', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const created = await games.createGame(owner, { title: 'Multiversus', platform: 'ps5' });

    await games.deleteGame(owner, created.id);

    expect(await games.listGames(owner)).toEqual([]);
  });
});

describe('listGames', () => {
  /**
   * The library reads as "what I last touched": `listGames` orders by
   * `updated_at desc`, which every write path sets by hand (there is no DB
   * trigger — see `updateGame`). Creation stamps it too, so a fresh library
   * reads newest-added first until something is edited. Platform plays no
   * part at all — a console-shelf ordering was rejected in real use, and if
   * it ever comes back this ordering breaks.
   */
  it('orders by last edited, newest first, regardless of platform', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const first = await games.createGame(owner, { title: 'Alpha', platform: 'ps5' });
    const second = await games.createGame(owner, { title: 'Bravo', platform: 'steam' });
    const third = await games.createGame(owner, { title: 'Charlie', platform: 'psp' });

    expect((await games.listGames(owner)).map((g) => g.id)).toEqual([
      third.id,
      second.id,
      first.id,
    ]);

    // Editing the oldest row moves it to the front.
    await games.updateGame(owner, first.id, { title: 'Alpha', platform: 'ps5', rating: 5 });

    expect((await games.listGames(owner)).map((g) => g.id)).toEqual([
      first.id,
      third.id,
      second.id,
    ]);
  });

  /**
   * Regression coverage for the N+1 the Task 4 brief explicitly called out:
   * `listGames` must fetch every owner's play-year splits with ONE call to
   * `listPlayYears`, grouping in memory, rather than one `listPlayYearsForGame`
   * call per row. Spying on both DAL functions proves which code path
   * actually ran, not just that the final result happens to look right — a
   * correct-looking result could still hide an N+1 if the test only checked
   * the returned data.
   */
  it("fetches every game's play-year split with ONE listPlayYears call, not one per game", async () => {
    const owner = await makeOwner('owner@burmy.test');
    const withSplit = await games.createGame(owner, {
      title: 'Hollow Knight',
      platform: 'steam',
      hoursTenths: 490,
    });
    const otherSplit = await games.createGame(owner, {
      title: 'Lies of P',
      platform: 'ps5',
      hoursTenths: 300,
    });
    const noSplit = await games.createGame(owner, {
      title: 'Returnal',
      platform: 'ps5',
      hoursTenths: 200,
    });

    await playYearsDb.replacePlayYears(owner, withSplit.id, [
      { year: 2024, hoursTenths: 370 },
      { year: 2025, hoursTenths: 120 },
    ]);
    await playYearsDb.replacePlayYears(owner, otherSplit.id, [{ year: 2023, hoursTenths: 300 }]);
    // noSplit deliberately has no game_play_years rows at all.

    const listSpy = vi.spyOn(playYearsDb, 'listPlayYears');
    const perGameSpy = vi.spyOn(playYearsDb, 'listPlayYearsForGame');

    const result = await games.listGames(owner);

    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(perGameSpy).not.toHaveBeenCalled();

    const byId = new Map(result.map((g) => [g.id, g]));
    expect(byId.get(withSplit.id)?.playYears).toEqual([
      { year: 2024, hoursTenths: 370 },
      { year: 2025, hoursTenths: 120 },
    ]);
    expect(byId.get(otherSplit.id)?.playYears).toEqual([{ year: 2023, hoursTenths: 300 }]);
    expect(byId.get(noSplit.id)?.playYears).toEqual([]);

    listSpy.mockRestore();
    perGameSpy.mockRestore();
  });
});

describe('listGameStatRows', () => {
  it('returns the narrow projection the stats layer consumes', async () => {
    const owner = await makeOwner('owner@burmy.test');
    await games.createGame(owner, {
      title: 'Ghost of Tsushima',
      platform: 'ps4',
      status: 'played',
      hoursTenths: 1080,
      firstPlayedYear: 2020,
      rating: 5,
      achievementsUnlocked: 69,
    });

    const rows = await games.listGameStatRows(owner);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: 'Ghost of Tsushima',
      hoursTenths: 1080,
      firstPlayedYear: 2020,
      rating: 5,
    });
  });

  it('excludes wanted (wishlist) games — they are not owned and must never enter a stat', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const owned = await games.createGame(owner, {
      title: 'Ghost of Tsushima',
      platform: 'ps4',
      status: 'played',
      hoursTenths: 1080,
      firstPlayedYear: 2020,
      rating: 5,
      priceCents: 5_999,
    });
    await games.createGame(owner, {
      title: 'Fable',
      platform: 'ps5',
      status: 'wanted',
      // A wishlist entry has no play history at all — if this row ever
      // leaked into a stat, it would show up as a zero-hour, zero-rating
      // game diluting an average, not just an extra count.
      hoursTenths: null,
      rating: null,
      priceCents: null,
    });

    const rows = await games.listGameStatRows(owner);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(owned.id);
    expect(rows.every((row) => row.status !== 'wanted')).toBe(true);
  });
});

describe('cross-owner isolation', () => {
  it('never returns another owner’s games', async () => {
    const mine = await makeOwner('mine@burmy.test');
    const theirs = await makeOwner('theirs@burmy.test');
    await games.createGame(theirs, { title: 'Their Game', platform: 'ps5' });

    expect(await games.listGames(mine)).toEqual([]);
    expect(await games.listGameStatRows(mine)).toEqual([]);
  });

  it('refuses to read, update, or delete across owners', async () => {
    const mine = await makeOwner('mine@burmy.test');
    const theirs = await makeOwner('theirs@burmy.test');
    const theirGame = await games.createGame(theirs, { title: 'Their Game', platform: 'ps5' });

    await expect(games.getGame(mine, theirGame.id)).rejects.toBeInstanceOf(
      errors.GameNotFoundError,
    );
    await expect(
      games.updateGame(mine, theirGame.id, { title: 'Hijacked', platform: 'ps5' }),
    ).rejects.toBeInstanceOf(errors.GameNotFoundError);
    await expect(games.deleteGame(mine, theirGame.id)).rejects.toBeInstanceOf(
      errors.GameNotFoundError,
    );
  });
});

/**
 * Upcoming games / wishlist — the DAL added for the "Upcoming games" tab.
 * The Server Action path built on top of this (owner resolution, zod
 * validation, `revalidatePath`) is `tests/integration/games-upcoming-actions.test.ts`'s
 * job — same split this suite already draws for the rest of the games
 * actions vs. their DAL.
 */
describe('createWishlistGame', () => {
  it('creates a wanted row stamped with igdbId, coverUrl and releaseDate', async () => {
    const owner = await makeOwner('owner@burmy.test');

    const created = await games.createWishlistGame(owner, {
      igdbId: 92550,
      title: 'Fable',
      coverUrl: 'https://images.igdb.com/igdb/image/upload/t_cover_big_2x/cobc6d.jpg',
      releaseDate: '2027-02-01',
      releasePrecision: null,
      platform: 'ps5',
    });

    expect(created.status).toBe('wanted');
    expect(created.title).toBe('Fable');
    expect(created.platform).toBe('ps5');
    expect(created.coverUrl).toBe(
      'https://images.igdb.com/igdb/image/upload/t_cover_big_2x/cobc6d.jpg',
    );

    const fetched = await games.getGame(owner, created.id);
    expect(fetched.status).toBe('wanted');
  });

  it('rejects a second wishlist add for the same igdbId, for the same owner', async () => {
    const owner = await makeOwner('owner@burmy.test');
    await games.createWishlistGame(owner, {
      igdbId: 92550,
      title: 'Fable',
      coverUrl: null,
      releaseDate: null,
      releasePrecision: null,
      platform: 'ps5',
    });

    await expect(
      games.createWishlistGame(owner, {
        igdbId: 92550,
        title: 'Fable (again)',
        coverUrl: null,
        releaseDate: null,
        releasePrecision: null,
        platform: 'ps5',
      }),
    ).rejects.toBeInstanceOf(errors.DuplicateWishlistGameError);
  });

  it('allows two different owners to each wishlist the same igdbId — the partial index is per owner', async () => {
    const mine = await makeOwner('mine@burmy.test');
    const theirs = await makeOwner('theirs@burmy.test');

    const myGame = await games.createWishlistGame(mine, {
      igdbId: 92550,
      title: 'Fable',
      coverUrl: null,
      releaseDate: null,
      releasePrecision: null,
      platform: 'ps5',
    });
    const theirGame = await games.createWishlistGame(theirs, {
      igdbId: 92550,
      title: 'Fable',
      coverUrl: null,
      releaseDate: null,
      releasePrecision: null,
      platform: 'ps5',
    });

    expect(myGame.id).not.toBe(theirGame.id);
  });
});

describe('listWishlistIgdbIds', () => {
  it('returns only this owner’s igdb ids, ignoring games with no igdbId at all', async () => {
    const owner = await makeOwner('owner@burmy.test');
    await games.createGame(owner, { title: 'Manually Added', platform: 'ps5' });
    await games.createWishlistGame(owner, {
      igdbId: 111,
      title: 'Wishlisted',
      coverUrl: null,
      releaseDate: null,
      releasePrecision: null,
      platform: 'ps5',
    });

    expect(await games.listWishlistIgdbIds(owner)).toEqual([111]);
  });

  it('still includes an igdb id after the owner moves its row to another status', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const row = await games.createWishlistGame(owner, {
      igdbId: 222,
      title: 'Released Now',
      coverUrl: null,
      releaseDate: '2020-01-01',
      releasePrecision: null,
      platform: 'ps5',
    });

    await games.updateGame(owner, row.id, {
      title: row.title,
      platform: row.platform,
      status: 'played',
    });

    // The feed must keep hiding a game the owner already has, whatever its status.
    expect(await games.listWishlistIgdbIds(owner)).toEqual([222]);
  });

  it('never returns another owner’s igdb ids', async () => {
    const mine = await makeOwner('mine@burmy.test');
    const theirs = await makeOwner('theirs@burmy.test');
    await games.createWishlistGame(theirs, {
      igdbId: 333,
      title: 'Theirs',
      coverUrl: null,
      releaseDate: null,
      releasePrecision: null,
      platform: 'ps5',
    });

    expect(await games.listWishlistIgdbIds(mine)).toEqual([]);
  });
});
