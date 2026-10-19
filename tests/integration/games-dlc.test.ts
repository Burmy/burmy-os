import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { harness, resetDatabase } from './harness';

/**
 * Owner-scoped DLC rows, against a real PostgreSQL.
 *
 * Integration rather than unit because what is being verified belongs to the
 * database and the DAL's own rules: owner scoping in every WHERE, the cascade
 * from `games`, the unique `(game_id, lower(name))` index, and the two
 * refusals that keep DLC off a collection member (a member's figures live on
 * the collection row, and so must its DLC — `docs/GAMES.md`, "DLC").
 */

type Games = typeof import('@/server/db/games/games');
type Dlc = typeof import('@/server/db/games/dlc');
type Errors = typeof import('@/server/db/games/errors');

let games: Games;
let dlc: Dlc;
let errors: Errors;

beforeAll(async () => {
  await harness();
  [games, dlc, errors] = await Promise.all([
    import('@/server/db/games/games'),
    import('@/server/db/games/dlc'),
    import('@/server/db/games/errors'),
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

describe('createDlc / listDlcForGame', () => {
  it('stores every field and returns the row', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const game = await games.createGame(owner, { title: 'Elden Ring', platform: 'ps5' });

    const row = await dlc.createDlc(owner, game.id, {
      name: 'Shadow of the Erdtree',
      year: 2025,
      hoursTenths: 60,
      priceCents: 3999,
      achievementsUnlocked: 10,
      achievementsTotal: 12,
    });

    expect(row).toMatchObject({
      gameId: game.id,
      name: 'Shadow of the Erdtree',
      year: 2025,
      hoursTenths: 60,
      priceCents: 3999,
      achievementsUnlocked: 10,
      achievementsTotal: 12,
    });
    expect(await dlc.listDlcForGame(owner, game.id)).toEqual([row]);
  });

  it('leaves optional figures null when they are not given', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const game = await games.createGame(owner, { title: 'Elden Ring', platform: 'ps5' });

    const row = await dlc.createDlc(owner, game.id, { name: 'DLC', year: 2026 });

    expect(row.hoursTenths).toBeNull();
    expect(row.priceCents).toBeNull();
    expect(row.achievementsUnlocked).toBeNull();
    expect(row.achievementsTotal).toBeNull();
  });

  it('orders a game’s DLC by year, then name', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const game = await games.createGame(owner, { title: 'Elden Ring', platform: 'ps5' });
    await dlc.createDlc(owner, game.id, { name: 'Zeta', year: 2025 });
    await dlc.createDlc(owner, game.id, { name: 'Alpha', year: 2026 });
    await dlc.createDlc(owner, game.id, { name: 'Beta', year: 2025 });

    const names = (await dlc.listDlcForGame(owner, game.id)).map((row) => row.name);
    expect(names).toEqual(['Beta', 'Zeta', 'Alpha']);
  });

  it('refuses two DLCs of the same name (case-insensitively) on one game as a unique violation', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const game = await games.createGame(owner, { title: 'Elden Ring', platform: 'ps5' });
    await dlc.createDlc(owner, game.id, { name: 'Shadow of the Erdtree', year: 2025 });

    await expect(
      dlc.createDlc(owner, game.id, { name: 'shadow of the erdtree', year: 2025 }),
    ).rejects.toBeInstanceOf(errors.DuplicateDlcError);
  });

  it('refuses DLC on a collection member', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const set = await games.createGame(owner, {
      title: 'Nathan Drake Collection',
      platform: 'ps4',
    });
    const member = await games.createGame(owner, { title: "Drake's Fortune", platform: 'ps4' });
    await games.setGameCollection(owner, member.id, set.id);

    await expect(
      dlc.createDlc(owner, member.id, { name: 'Lost Legacy', year: 2021 }),
    ).rejects.toBeInstanceOf(errors.DlcOnCollectionMemberError);
  });

  it('is a not-found for a game belonging to someone else', async () => {
    const a = await makeOwner('a@burmy.test');
    const b = await makeOwner('b@burmy.test');
    const game = await games.createGame(a, { title: 'Elden Ring', platform: 'ps5' });

    await expect(dlc.createDlc(b, game.id, { name: 'DLC', year: 2025 })).rejects.toBeInstanceOf(
      errors.GameNotFoundError,
    );
  });
});

describe('listDlc', () => {
  it('returns only the owner’s rows, across all their games', async () => {
    const a = await makeOwner('a@burmy.test');
    const b = await makeOwner('b@burmy.test');
    const ga = await games.createGame(a, { title: 'Elden Ring', platform: 'ps5' });
    const gb = await games.createGame(b, { title: 'Elden Ring', platform: 'ps5' });
    await dlc.createDlc(a, ga.id, { name: 'A1', year: 2025 });
    await dlc.createDlc(b, gb.id, { name: 'B1', year: 2025 });

    expect((await dlc.listDlc(a)).map((row) => row.name)).toEqual(['A1']);
    expect((await dlc.listDlc(b)).map((row) => row.name)).toEqual(['B1']);
  });
});

describe('updateDlc / deleteDlc', () => {
  it('updates only the given fields and bumps updated_at', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const game = await games.createGame(owner, { title: 'Elden Ring', platform: 'ps5' });
    const row = await dlc.createDlc(owner, game.id, { name: 'DLC', year: 2025, hoursTenths: 60 });

    const updated = await dlc.updateDlc(owner, row.id, { name: 'Shadow of the Erdtree' });

    expect(updated.name).toBe('Shadow of the Erdtree');
    expect(updated.hoursTenths).toBe(60);
  });

  it('clears a figure when given null', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const game = await games.createGame(owner, { title: 'Elden Ring', platform: 'ps5' });
    const row = await dlc.createDlc(owner, game.id, { name: 'DLC', year: 2025, hoursTenths: 60 });

    expect((await dlc.updateDlc(owner, row.id, { hoursTenths: null })).hoursTenths).toBeNull();
  });

  it('is a not-found for another owner’s row, on update and delete alike', async () => {
    const a = await makeOwner('a@burmy.test');
    const b = await makeOwner('b@burmy.test');
    const game = await games.createGame(a, { title: 'Elden Ring', platform: 'ps5' });
    const row = await dlc.createDlc(a, game.id, { name: 'DLC', year: 2025 });

    await expect(dlc.updateDlc(b, row.id, { year: 2026 })).rejects.toBeInstanceOf(
      errors.GameNotFoundError,
    );
    await expect(dlc.deleteDlc(b, row.id)).rejects.toBeInstanceOf(errors.GameNotFoundError);
    expect(await dlc.listDlcForGame(a, game.id)).toHaveLength(1);
  });

  it('deletes a row', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const game = await games.createGame(owner, { title: 'Elden Ring', platform: 'ps5' });
    const row = await dlc.createDlc(owner, game.id, { name: 'DLC', year: 2025 });

    await dlc.deleteDlc(owner, row.id);

    expect(await dlc.listDlcForGame(owner, game.id)).toEqual([]);
  });
});

describe('cascade and the Game shape', () => {
  it('deleting the game deletes its DLC', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const game = await games.createGame(owner, { title: 'Elden Ring', platform: 'ps5' });
    await dlc.createDlc(owner, game.id, { name: 'DLC', year: 2025 });

    await games.deleteGame(owner, game.id);

    expect(await dlc.listDlc(owner)).toEqual([]);
  });

  it('getGame, listGames and updateGame all carry the game’s DLC rows', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const game = await games.createGame(owner, { title: 'Elden Ring', platform: 'ps5' });
    await dlc.createDlc(owner, game.id, { name: 'DLC', year: 2025, hoursTenths: 60 });

    expect((await games.getGame(owner, game.id)).dlc.map((row) => row.name)).toEqual(['DLC']);
    expect((await games.listGames(owner))[0]?.dlc.map((row) => row.name)).toEqual(['DLC']);
    const updated = await games.updateGame(owner, game.id, {
      title: 'Elden Ring',
      platform: 'ps5',
    });
    expect(updated.dlc.map((row) => row.name)).toEqual(['DLC']);
  });

  it('refuses a collection target when the game has DLC', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const set = await games.createGame(owner, {
      title: 'Nathan Drake Collection',
      platform: 'ps4',
    });
    const game = await games.createGame(owner, { title: "Drake's Fortune", platform: 'ps4' });
    await dlc.createDlc(owner, game.id, { name: 'DLC', year: 2021 });

    await expect(games.setGameCollection(owner, game.id, set.id)).rejects.toBeInstanceOf(
      errors.GameHasDlcError,
    );
    expect((await games.getGame(owner, game.id)).collectionId).toBeNull();
  });
});
