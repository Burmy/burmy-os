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
    expect(created.status).toBe('backlog');
    expect(created.hoursTenths).toBeNull();
    expect(created.rating).toBeNull();
  });

  it('rejects the same title twice on one platform', async () => {
    const owner = await makeOwner('owner@burmy.test');
    await games.createGame(owner, { title: 'Elden Ring', platform: 'ps5' });

    await expect(games.createGame(owner, { title: 'elden ring', platform: 'ps5' })).rejects.toBeInstanceOf(
      errors.DuplicateGameError,
    );
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
      status: 'completed',
      hoursTenths: 240,
      rating: 3,
    });

    expect(updated.status).toBe('completed');
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
   * Regression for the "unplayed backlog game sorts above everything the
   * owner actually played" bug. Postgres `DESC` defaults to NULLS FIRST, so
   * a naive `desc(firstPlayedYear)` put every no-year game at the very TOP.
   * This is the whole protection against that regressing — see the ordering
   * comment on `listGames` in `src/server/db/games/games.ts`.
   */
  it('orders newest-played first with unplayed (no-year) games LAST, ranked by the deliberate platform order among themselves', async () => {
    const owner = await makeOwner('owner@burmy.test');

    // Two played games on different years — must sort by year, descending.
    const playedOlder = await games.createGame(owner, {
      title: 'Old Game',
      platform: 'ps4',
      firstPlayedYear: 2020,
    });
    const playedNewer = await games.createGame(owner, {
      title: 'New Game',
      platform: 'ps5',
      firstPlayedYear: 2023,
    });

    // Six no-year (unplayed/backlog) games, one per platform value, created
    // in an order that is neither the expected output order nor alphabetical
    // — so passing this test actually proves the ORDER BY did the work, not
    // insertion order or a lucky title sort.
    const noYearOther = await games.createGame(owner, { title: 'Zed', platform: 'other' });
    const noYearPsp = await games.createGame(owner, { title: 'Psp Game', platform: 'psp' });
    const noYearPc = await games.createGame(owner, { title: 'Pc Game', platform: 'pc' });
    const noYearSteam = await games.createGame(owner, { title: 'Steam Game', platform: 'steam' });
    const noYearPs4 = await games.createGame(owner, { title: 'Ps4 Game', platform: 'ps4' });
    const noYearPs5 = await games.createGame(owner, { title: 'Ps5 Game', platform: 'ps5' });

    const result = await games.listGames(owner);

    expect(result.map((g) => g.id)).toEqual([
      playedNewer.id, // 2023 — most recently played
      playedOlder.id, // 2020
      // Everything below has no recorded year at all — NULLS LAST, not first.
      noYearPs5.id,
      noYearPs4.id,
      // steam and pc share rank 2 (both render as "Steam / PC" — see
      // PLATFORM_LABELS), so they tiebreak by title: "Pc Game" < "Steam Game".
      noYearPc.id,
      noYearSteam.id,
      noYearPsp.id,
      noYearOther.id,
    ]);
  });

  it('breaks a tie between two PLAYED games on the same year by title alone, not by the no-year platform rule', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const laterAlphabetically = await games.createGame(owner, {
      title: 'Bravo',
      platform: 'ps4', // would rank AFTER 'Alpha's ps5 under the no-year rule too, but that rule must not even apply here
      firstPlayedYear: 2021,
    });
    const earlierAlphabetically = await games.createGame(owner, {
      title: 'Alpha',
      platform: 'ps5',
      firstPlayedYear: 2021,
    });

    const result = await games.listGames(owner);

    expect(result.map((g) => g.id)).toEqual([earlierAlphabetically.id, laterAlphabetically.id]);
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
    const withSplit = await games.createGame(owner, { title: 'Hollow Knight', platform: 'steam', hoursTenths: 490 });
    const otherSplit = await games.createGame(owner, { title: 'Lies of P', platform: 'ps5', hoursTenths: 300 });
    const noSplit = await games.createGame(owner, { title: 'Returnal', platform: 'ps5', hoursTenths: 200 });

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
      status: 'completed',
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

    await expect(games.getGame(mine, theirGame.id)).rejects.toBeInstanceOf(errors.GameNotFoundError);
    await expect(
      games.updateGame(mine, theirGame.id, { title: 'Hijacked', platform: 'ps5' }),
    ).rejects.toBeInstanceOf(errors.GameNotFoundError);
    await expect(games.deleteGame(mine, theirGame.id)).rejects.toBeInstanceOf(errors.GameNotFoundError);
  });
});
