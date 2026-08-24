import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { harness, resetDatabase } from './harness';

/**
 * The play-year data access layer against real PostgreSQL 18. Integration
 * rather than unit because everything worth proving here belongs to the
 * database: the (game_id, year) unique index, owner scoping in every WHERE,
 * and the cascade from `games`.
 */

type PlayYears = typeof import('@/server/db/games/play-years');
type Games = typeof import('@/server/db/games/games');

let playYears: PlayYears;
let games: Games;

beforeAll(async () => {
  await harness();
  [playYears, games] = await Promise.all([
    import('@/server/db/games/play-years'),
    import('@/server/db/games/games'),
  ]);
});

beforeEach(async () => {
  await resetDatabase();
});

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

async function makeGame(ownerId: string, title: string): Promise<string> {
  const created = await games.createGame(ownerId, {
    title,
    platform: 'steam',
    status: 'completed',
    hoursTenths: 490,
    platinum: false,
  });
  return created.id;
}

describe('play-year data access', () => {
  it('round-trips a split for one game', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameId = await makeGame(owner, 'Hollow Knight');

    await playYears.replacePlayYears(owner, gameId, [
      { year: 2024, hoursTenths: 370 },
      { year: 2025, hoursTenths: 120 },
    ]);

    const rows = await playYears.listPlayYearsForGame(owner, gameId);
    expect(rows).toEqual([
      { gameId, year: 2024, hoursTenths: 370 },
      { gameId, year: 2025, hoursTenths: 120 },
    ]);
  });

  it('replaces rather than appends on a second call', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameId = await makeGame(owner, 'Hollow Knight');

    await playYears.replacePlayYears(owner, gameId, [{ year: 2024, hoursTenths: 490 }]);
    await playYears.replacePlayYears(owner, gameId, [
      { year: 2024, hoursTenths: 370 },
      { year: 2025, hoursTenths: 120 },
    ]);

    expect(await playYears.listPlayYearsForGame(owner, gameId)).toHaveLength(2);
  });

  it('clears a split when handed an empty list', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameId = await makeGame(owner, 'Hollow Knight');

    await playYears.replacePlayYears(owner, gameId, [{ year: 2024, hoursTenths: 490 }]);
    await playYears.replacePlayYears(owner, gameId, []);

    expect(await playYears.listPlayYearsForGame(owner, gameId)).toEqual([]);
  });

  it('never returns another owner rows', async () => {
    const mine = await makeOwner('mine@example.invalid');
    const theirs = await makeOwner('theirs@example.invalid');
    const myGame = await makeGame(mine, 'Hollow Knight');
    const theirGame = await makeGame(theirs, 'Lies of P');

    await playYears.replacePlayYears(mine, myGame, [{ year: 2024, hoursTenths: 370 }]);
    await playYears.replacePlayYears(theirs, theirGame, [{ year: 2024, hoursTenths: 520 }]);

    const all = await playYears.listPlayYears(mine);
    expect(all).toEqual([{ gameId: myGame, year: 2024, hoursTenths: 370 }]);
  });

  it('refuses to write a split onto another owner game', async () => {
    const mine = await makeOwner('mine@example.invalid');
    const theirs = await makeOwner('theirs@example.invalid');
    const theirGame = await makeGame(theirs, 'Lies of P');

    await playYears.replacePlayYears(mine, theirGame, [{ year: 2024, hoursTenths: 370 }]);

    expect(await playYears.listPlayYearsForGame(theirs, theirGame)).toEqual([]);
  });

  it('cascades away when its game is deleted', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameId = await makeGame(owner, 'Hollow Knight');
    await playYears.replacePlayYears(owner, gameId, [{ year: 2024, hoursTenths: 370 }]);

    await games.deleteGame(owner, gameId);

    expect(await playYears.listPlayYears(owner)).toEqual([]);
  });

  it('orders rows by year ascending', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameId = await makeGame(owner, 'Hollow Knight');

    await playYears.replacePlayYears(owner, gameId, [
      { year: 2025, hoursTenths: 120 },
      { year: 2023, hoursTenths: 10 },
      { year: 2024, hoursTenths: 370 },
    ]);

    expect((await playYears.listPlayYearsForGame(owner, gameId)).map((r) => r.year)).toEqual([2023, 2024, 2025]);
  });
});
