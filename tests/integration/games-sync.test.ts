import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { harness, resetDatabase } from './harness';

/**
 * The sync-run data access layer against real PostgreSQL 18. Integration
 * rather than unit because everything worth proving here belongs to the
 * database: owner scoping in every WHERE, the cascade from `game_sync_runs`
 * to `game_sync_changes`, and the ownership pre-check inside the
 * `appendSyncChanges` transaction.
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

describe('sync run data access', () => {
  it('creates a run in the running state with a cursor of zero', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const run = await sync.createSyncRun(owner, 'steam', 47, [{ appid: 1, name: 'A', playtimeMinutes: 0 }]);

    expect(run).toMatchObject({ source: 'steam', status: 'running', cursor: 0, total: 47 });
  });

  it('round-trips the steam library snapshot', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const library = [{ appid: 367520, name: 'Hollow Knight', playtimeMinutes: 2940 }];
    const run = await sync.createSyncRun(owner, 'steam', 1, library);

    expect(await sync.getSyncRunLibrary(owner, run.id)).toEqual(library);
  });

  it('appends changes and advances the cursor together', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameId = await makeGame(owner, 'Hollow Knight');
    const run = await sync.createSyncRun(owner, 'steam', 10, []);

    await sync.appendSyncChanges(
      owner,
      run.id,
      [{ kind: 'link', gameId, title: 'Hollow Knight', payload: { steamAppid: 367520 } }],
      5,
    );

    expect((await sync.getSyncRun(owner, run.id))?.cursor).toBe(5);
    expect(await sync.listSyncChanges(owner, run.id)).toHaveLength(1);
  });

  it('stages a new_game change with a null gameId', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const run = await sync.createSyncRun(owner, 'steam', 1, []);

    await sync.appendSyncChanges(
      owner,
      run.id,
      [{ kind: 'new_game', gameId: null, title: 'Forza Horizon 6', payload: { steamAppid: 2483190 } }],
      1,
    );

    const [change] = await sync.listSyncChanges(owner, run.id);
    expect(change).toMatchObject({ kind: 'new_game', gameId: null, selected: true });
  });

  it('stages a reconcile change as unselected while a link in the same call stays selected', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameId = await makeGame(owner, 'Hollow Knight');
    const run = await sync.createSyncRun(owner, 'steam', 2, []);

    await sync.appendSyncChanges(
      owner,
      run.id,
      [
        { kind: 'link', gameId, title: 'Hollow Knight', payload: { steamAppid: 367520 } },
        { kind: 'reconcile', gameId, title: 'Hollow Knight', payload: { reason: 'split does not add up' } },
      ],
      2,
    );

    const changes = await sync.listSyncChanges(owner, run.id);
    const link = changes.find((c) => c.kind === 'link');
    const reconcile = changes.find((c) => c.kind === 'reconcile');

    expect(link?.selected).toBe(true);
    expect(reconcile?.selected).toBe(false);
  });

  it('never returns another owner run or its changes', async () => {
    const mine = await makeOwner('mine@example.invalid');
    const theirs = await makeOwner('theirs@example.invalid');
    const theirRun = await sync.createSyncRun(theirs, 'steam', 1, []);
    await sync.appendSyncChanges(theirs, theirRun.id, [
      { kind: 'new_game', gameId: null, title: 'Theirs', payload: {} },
    ], 1);

    expect(await sync.getSyncRun(mine, theirRun.id)).toBeNull();
    expect(await sync.listSyncChanges(mine, theirRun.id)).toEqual([]);
  });

  it('never returns another owner run library snapshot', async () => {
    const mine = await makeOwner('mine@example.invalid');
    const theirs = await makeOwner('theirs@example.invalid');
    const library = [{ appid: 1, name: 'Theirs', playtimeMinutes: 0 }];
    const theirRun = await sync.createSyncRun(theirs, 'steam', 1, library);

    expect(await sync.getSyncRunLibrary(mine, theirRun.id)).toBeNull();
  });

  it('refuses to append to another owner run', async () => {
    const mine = await makeOwner('mine@example.invalid');
    const theirs = await makeOwner('theirs@example.invalid');
    const theirRun = await sync.createSyncRun(theirs, 'steam', 1, []);

    await sync.appendSyncChanges(mine, theirRun.id, [
      { kind: 'new_game', gameId: null, title: 'Injected', payload: {} },
    ], 1);

    expect(await sync.listSyncChanges(theirs, theirRun.id)).toEqual([]);
    expect((await sync.getSyncRun(theirs, theirRun.id))?.cursor).toBe(0);

    // The assertions above alone are vacuous: a buggy write that skipped the
    // ownership check but still inserted using the CALLER's ownerId (`mine`)
    // would land as { ownerId: mine, runId: theirRun.id } — invisible to a
    // query scoped to `theirs`, but a real row would still exist. Count rows
    // for this run_id directly, with no owner filter at all, to prove no
    // write happened under ANY owner.
    const { sql } = await harness();
    const rows = await sql`select count(*)::int as count from game_sync_changes where run_id = ${theirRun.id}`;
    expect(rows[0]?.count).toBe(0);
  });

  it('refuses to toggle another owner change', async () => {
    const mine = await makeOwner('mine@example.invalid');
    const theirs = await makeOwner('theirs@example.invalid');
    const theirRun = await sync.createSyncRun(theirs, 'steam', 1, []);
    await sync.appendSyncChanges(theirs, theirRun.id, [
      { kind: 'new_game', gameId: null, title: 'Theirs', payload: {} },
    ], 1);
    const [change] = await sync.listSyncChanges(theirs, theirRun.id);

    await sync.setSyncChangeSelected(mine, change!.id, false);

    const [after] = await sync.listSyncChanges(theirs, theirRun.id);
    expect(after?.selected).toBe(true);
  });

  it('marks a run finished with an error message', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const run = await sync.createSyncRun(owner, 'steam', 1, []);

    await sync.finishSyncRun(owner, run.id, 'failed', 'Steam did not respond');

    const after = await sync.getSyncRun(owner, run.id);
    expect(after).toMatchObject({ status: 'failed', errorMessage: 'Steam did not respond' });
  });

  it('cascades its changes away when the run is deleted', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const run = await sync.createSyncRun(owner, 'steam', 1, []);
    await sync.appendSyncChanges(owner, run.id, [
      { kind: 'new_game', gameId: null, title: 'X', payload: {} },
    ], 1);

    const { sql } = await harness();
    await sql`delete from game_sync_runs where id = ${run.id}`;

    expect(await sync.listSyncChanges(owner, run.id)).toEqual([]);
  });
});
