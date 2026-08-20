import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

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

let games: Games;
let errors: Errors;

beforeAll(async () => {
  await harness();
  [games, errors] = await Promise.all([
    import('@/server/db/games/games'),
    import('@/server/db/games/errors'),
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
});

describe('deleteGame', () => {
  it('removes the row', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const created = await games.createGame(owner, { title: 'Multiversus', platform: 'ps5' });

    await games.deleteGame(owner, created.id);

    expect(await games.listGames(owner)).toEqual([]);
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
