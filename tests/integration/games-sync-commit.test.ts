import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { countRows, harness, resetDatabase } from './harness';

/**
 * `commitSyncRun` (`src/server/db/games/sync.ts`) against real PostgreSQL 18
 * — the one function in the whole Steam sync feature allowed to write to
 * `games`. Integration rather than unit because everything worth proving
 * here belongs to the database: the whitelist that keeps a `field_update`
 * payload from ever becoming a dynamic column name, transactional
 * all-or-nothing commit, and owner scoping on the run itself.
 */

type Sync = typeof import('@/server/db/games/sync');
type Games = typeof import('@/server/db/games/games');

let sync: Sync;
let games: Games;

beforeAll(async () => {
  await harness();
  [sync, games] = await Promise.all([
    import('@/server/db/games/sync'),
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

async function makeGame(
  ownerId: string,
  title: string,
  overrides: Partial<Parameters<Games['createGame']>[1]> = {},
): Promise<string> {
  const created = await games.createGame(ownerId, {
    title,
    platform: 'steam',
    status: 'completed',
    hoursTenths: 490,
    platinum: false,
    ...overrides,
  });
  return created.id;
}

describe('commitSyncRun', () => {
  it('applies only selected changes', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameA = await makeGame(owner, 'Hollow Knight', { hoursTenths: 490 });
    const gameB = await makeGame(owner, 'Celeste', { hoursTenths: 100 });
    const run = await sync.createSyncRun(owner, 'steam', 2, []);

    await sync.appendSyncChanges(
      owner,
      run.id,
      [
        { kind: 'field_update', gameId: gameA, title: 'Hollow Knight', payload: { field: 'hoursTenths', from: 490, to: 600 } },
        { kind: 'field_update', gameId: gameB, title: 'Celeste', payload: { field: 'hoursTenths', from: 100, to: 200 } },
      ],
      2,
    );

    const staged = await sync.listSyncChanges(owner, run.id);
    const celesteChange = staged.find((change) => change.gameId === gameB);
    await sync.setSyncChangeSelected(owner, celesteChange!.id, false);

    await sync.commitSyncRun(owner, run.id);

    const a = await games.getGame(owner, gameA);
    const b = await games.getGame(owner, gameB);
    expect(a.hoursTenths).toBe(600);
    expect(b.hoursTenths).toBe(100);
  });

  it('creates a game for a selected new_game change', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const run = await sync.createSyncRun(owner, 'steam', 0, []);

    await sync.appendSyncChanges(
      owner,
      run.id,
      [
        {
          kind: 'new_game',
          gameId: null,
          title: 'Half-Life: Opposing Force',
          payload: { steamAppid: 50, hoursTenths: 73, platform: 'steam' },
        },
      ],
      0,
    );

    await sync.commitSyncRun(owner, run.id);

    const all = await games.listGames(owner);
    const created = all.find((game) => game.title === 'Half-Life: Opposing Force');
    expect(created).toMatchObject({
      steamAppid: 50,
      hoursTenths: 73,
      platform: 'steam',
      status: 'completed',
    });
  });

  it('derives backlog status for a zero-hour new game', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const run = await sync.createSyncRun(owner, 'steam', 0, []);

    await sync.appendSyncChanges(
      owner,
      run.id,
      [
        {
          kind: 'new_game',
          gameId: null,
          title: 'Team Fortress Classic',
          payload: { steamAppid: 20, hoursTenths: 0, platform: 'steam' },
        },
      ],
      0,
    );

    await sync.commitSyncRun(owner, run.id);

    const all = await games.listGames(owner);
    const created = all.find((game) => game.title === 'Team Fortress Classic');
    expect(created?.status).toBe('backlog');
  });

  it('does not create a game for a deselected new_game change', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const run = await sync.createSyncRun(owner, 'steam', 0, []);

    await sync.appendSyncChanges(
      owner,
      run.id,
      [{ kind: 'new_game', gameId: null, title: 'Ricochet', payload: { steamAppid: 60, hoursTenths: 5, platform: 'steam' } }],
      0,
    );

    const [change] = await sync.listSyncChanges(owner, run.id);
    await sync.setSyncChangeSelected(owner, change!.id, false);

    const before = await countRows('games');
    await sync.commitSyncRun(owner, run.id);
    const after = await countRows('games');

    expect(after).toBe(before);
    const all = await games.listGames(owner);
    expect(all.find((game) => game.title === 'Ricochet')).toBeUndefined();
  });

  it('leaves every game not named by a change byte-identical', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameA = await makeGame(owner, 'Hollow Knight', { hoursTenths: 490 });
    const gameB = await makeGame(owner, 'Celeste', { hoursTenths: 100 });
    const gameC = await makeGame(owner, 'Hades', { hoursTenths: 210 });
    const run = await sync.createSyncRun(owner, 'steam', 1, []);

    await sync.appendSyncChanges(
      owner,
      run.id,
      [{ kind: 'field_update', gameId: gameA, title: 'Hollow Knight', payload: { field: 'hoursTenths', from: 490, to: 600 } }],
      1,
    );

    const bBefore = await games.getGame(owner, gameB);
    const cBefore = await games.getGame(owner, gameC);

    await sync.commitSyncRun(owner, run.id);

    const bAfter = await games.getGame(owner, gameB);
    const cAfter = await games.getGame(owner, gameC);

    expect(bAfter).toEqual(bBefore);
    expect(cAfter).toEqual(cBefore);
  });

  it('never reduces the games row count', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameA = await makeGame(owner, 'Hollow Knight', { hoursTenths: 490 });
    const run = await sync.createSyncRun(owner, 'steam', 1, []);

    await sync.appendSyncChanges(
      owner,
      run.id,
      [
        { kind: 'field_update', gameId: gameA, title: 'Hollow Knight', payload: { field: 'hoursTenths', from: 490, to: 600 } },
        { kind: 'new_game', gameId: null, title: 'Portal', payload: { steamAppid: 400, hoursTenths: 40, platform: 'steam' } },
      ],
      1,
    );

    const before = await countRows('games');
    await sync.commitSyncRun(owner, run.id);
    const after = await countRows('games');

    expect(after).toBeGreaterThanOrEqual(before);
    expect(after).toBe(before + 1);
  });

  it('applies a link before a field_update on the same game', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameId = await makeGame(owner, 'Hollow Knight', { steamAppid: null, hoursTenths: 490 });
    const run = await sync.createSyncRun(owner, 'steam', 1, []);

    // Staged field_update THEN link — insertion order deliberately reversed
    // from the required apply order, to prove the commit reorders rather
    // than trusting staging order.
    await sync.appendSyncChanges(
      owner,
      run.id,
      [
        { kind: 'field_update', gameId, title: 'Hollow Knight', payload: { field: 'hoursTenths', from: 490, to: 600 } },
        { kind: 'link', gameId, title: 'Hollow Knight', payload: { steamAppid: 367520 } },
      ],
      1,
    );

    await sync.commitSyncRun(owner, run.id);

    const after = await games.getGame(owner, gameId);
    expect(after.steamAppid).toBe(367520);
    expect(after.hoursTenths).toBe(600);
  });

  it('skips reconcile entirely', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameId = await makeGame(owner, 'Hollow Knight', { hoursTenths: 490 });
    const run = await sync.createSyncRun(owner, 'steam', 1, []);

    await sync.appendSyncChanges(
      owner,
      run.id,
      [
        {
          kind: 'reconcile',
          gameId,
          title: 'Hollow Knight',
          payload: { splitTenths: 490, newTotalTenths: 600, differenceTenths: 110 },
        },
      ],
      1,
    );

    const [change] = await sync.listSyncChanges(owner, run.id);
    // Sanity check on the staging default this test deliberately overrides below.
    expect(change?.selected).toBe(false);

    // Force selected: true directly, bypassing the app layer entirely — this
    // test is about the COMMIT's own guard against applying a reconcile, not
    // about whether staging ever selects one.
    const { sql } = await harness();
    await sql`update game_sync_changes set selected = true where id = ${change!.id}`;

    const before = await games.getGame(owner, gameId);
    const result = await sync.commitSyncRun(owner, run.id);
    const after = await games.getGame(owner, gameId);

    expect(after).toEqual(before);
    expect(result).toEqual({ applied: 0, created: 0 });
  });

  it('rejects a payload naming a non-syncable column', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameId = await makeGame(owner, 'Hollow Knight');
    const run = await sync.createSyncRun(owner, 'steam', 1, []);

    await sync.appendSyncChanges(
      owner,
      run.id,
      [{ kind: 'field_update', gameId, title: 'Hollow Knight', payload: { field: 'title', from: 'Hollow Knight', to: 'Hacked' } }],
      1,
    );

    await expect(sync.commitSyncRun(owner, run.id)).rejects.toThrow();

    const after = await games.getGame(owner, gameId);
    expect(after.title).toBe('Hollow Knight');
  });

  it('marks the run committed', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const run = await sync.createSyncRun(owner, 'steam', 0, []);

    await sync.commitSyncRun(owner, run.id);

    const after = await sync.getSyncRun(owner, run.id);
    expect(after?.status).toBe('committed');
  });

  it('rejects committing the same run twice', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const run = await sync.createSyncRun(owner, 'steam', 0, []);

    await sync.commitSyncRun(owner, run.id);

    await expect(sync.commitSyncRun(owner, run.id)).rejects.toThrow();
  });

  it("rejects committing another owner's run", async () => {
    const mine = await makeOwner('mine@example.invalid');
    const theirs = await makeOwner('theirs@example.invalid');
    const gameId = await makeGame(theirs, 'Their Game', { hoursTenths: 490 });
    const run = await sync.createSyncRun(theirs, 'steam', 1, []);

    await sync.appendSyncChanges(
      theirs,
      run.id,
      [{ kind: 'field_update', gameId, title: 'Their Game', payload: { field: 'hoursTenths', from: 490, to: 900 } }],
      1,
    );

    await expect(sync.commitSyncRun(mine, run.id)).rejects.toThrow();

    const after = await games.getGame(theirs, gameId);
    expect(after.hoursTenths).toBe(490);
    const runAfter = await sync.getSyncRun(theirs, run.id);
    expect(runAfter?.status).not.toBe('committed');
  });

  it('applies all changes in one transaction — a failure applies none', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameA = await makeGame(owner, 'Hollow Knight', { hoursTenths: 490 });
    const gameB = await makeGame(owner, 'Celeste', { hoursTenths: 100 });
    const run = await sync.createSyncRun(owner, 'steam', 2, []);

    await sync.appendSyncChanges(
      owner,
      run.id,
      [
        // Valid, and staged (so ordered) FIRST — proves an already-applied
        // write inside the transaction still rolls back.
        { kind: 'field_update', gameId: gameA, title: 'Hollow Knight', payload: { field: 'hoursTenths', from: 490, to: 600 } },
        // Invalid — names a column the whitelist refuses.
        { kind: 'field_update', gameId: gameB, title: 'Celeste', payload: { field: 'title', from: 'Celeste', to: 'Hacked' } },
      ],
      2,
    );

    await expect(sync.commitSyncRun(owner, run.id)).rejects.toThrow();

    const a = await games.getGame(owner, gameA);
    const b = await games.getGame(owner, gameB);
    expect(a.hoursTenths).toBe(490);
    expect(b.title).toBe('Celeste');

    const runAfter = await sync.getSyncRun(owner, run.id);
    expect(runAfter?.status).not.toBe('committed');
  });
});
