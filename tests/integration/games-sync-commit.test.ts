import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { countRows, harness, resetDatabase } from './harness';

/**
 * `commitSyncRun` (`src/server/db/games/sync.ts`) against real PostgreSQL 18
 * — the one function in the whole Steam sync feature allowed to write to
 * `games`. Integration rather than unit because everything worth proving
 * here belongs to the database: the whitelist that keeps a `field_update`
 * payload from ever becoming a dynamic column name, transactional
 * all-or-nothing commit, owner scoping on the run itself, the `ready`-only
 * gate, and the `pg_advisory_xact_lock` that makes that gate actually hold
 * under real concurrency.
 */

type Sync = typeof import('@/server/db/games/sync');
type Games = typeof import('@/server/db/games/games');
type Errors = typeof import('@/server/db/games/errors');

let sync: Sync;
let games: Games;
let errors: Errors;

beforeAll(async () => {
  await harness();
  [sync, games, errors] = await Promise.all([
    import('@/server/db/games/sync'),
    import('@/server/db/games/games'),
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

/** Every real commit test needs the run past `running` first — `commitSyncRun` now refuses anything but `ready`. */
async function makeReadyRun(ownerId: string, total: number, library: unknown[] = []): Promise<string> {
  const run = await sync.createSyncRun(ownerId, 'steam', total, library);
  await sync.finishSyncRun(ownerId, run.id, 'ready');
  return run.id;
}

describe('commitSyncRun', () => {
  it('applies only selected changes', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameA = await makeGame(owner, 'Hollow Knight', { hoursTenths: 490 });
    const gameB = await makeGame(owner, 'Celeste', { hoursTenths: 100 });
    const runId = await makeReadyRun(owner, 2);

    await sync.appendSyncChanges(
      owner,
      runId,
      [
        { kind: 'field_update', gameId: gameA, title: 'Hollow Knight', payload: { field: 'hoursTenths', from: 490, to: 600 } },
        { kind: 'field_update', gameId: gameB, title: 'Celeste', payload: { field: 'hoursTenths', from: 100, to: 200 } },
      ],
      2,
    );

    const staged = await sync.listSyncChanges(owner, runId);
    const celesteChange = staged.find((change) => change.gameId === gameB);
    await sync.setSyncChangeSelected(owner, celesteChange!.id, false);

    await sync.commitSyncRun(owner, runId);

    const a = await games.getGame(owner, gameA);
    const b = await games.getGame(owner, gameB);
    expect(a.hoursTenths).toBe(600);
    expect(b.hoursTenths).toBe(100);
  });

  it('creates a game for a selected new_game change', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const runId = await makeReadyRun(owner, 0);

    await sync.appendSyncChanges(
      owner,
      runId,
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

    await sync.commitSyncRun(owner, runId);

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
    const runId = await makeReadyRun(owner, 0);

    await sync.appendSyncChanges(
      owner,
      runId,
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

    await sync.commitSyncRun(owner, runId);

    const all = await games.listGames(owner);
    const created = all.find((game) => game.title === 'Team Fortress Classic');
    expect(created?.status).toBe('backlog');
  });

  it('does not create a game for a deselected new_game change', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const runId = await makeReadyRun(owner, 0);

    await sync.appendSyncChanges(
      owner,
      runId,
      [{ kind: 'new_game', gameId: null, title: 'Ricochet', payload: { steamAppid: 60, hoursTenths: 5, platform: 'steam' } }],
      0,
    );

    const [change] = await sync.listSyncChanges(owner, runId);
    await sync.setSyncChangeSelected(owner, change!.id, false);

    const before = await countRows('games');
    await sync.commitSyncRun(owner, runId);
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
    const runId = await makeReadyRun(owner, 1);

    await sync.appendSyncChanges(
      owner,
      runId,
      [{ kind: 'field_update', gameId: gameA, title: 'Hollow Knight', payload: { field: 'hoursTenths', from: 490, to: 600 } }],
      1,
    );

    const bBefore = await games.getGame(owner, gameB);
    const cBefore = await games.getGame(owner, gameC);

    await sync.commitSyncRun(owner, runId);

    const bAfter = await games.getGame(owner, gameB);
    const cAfter = await games.getGame(owner, gameC);

    expect(bAfter).toEqual(bBefore);
    expect(cAfter).toEqual(cBefore);
  });

  it('never reduces the games row count', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameA = await makeGame(owner, 'Hollow Knight', { hoursTenths: 490 });
    const runId = await makeReadyRun(owner, 1);

    await sync.appendSyncChanges(
      owner,
      runId,
      [
        { kind: 'field_update', gameId: gameA, title: 'Hollow Knight', payload: { field: 'hoursTenths', from: 490, to: 600 } },
        { kind: 'new_game', gameId: null, title: 'Portal', payload: { steamAppid: 400, hoursTenths: 40, platform: 'steam' } },
      ],
      1,
    );

    const before = await countRows('games');
    await sync.commitSyncRun(owner, runId);
    const after = await countRows('games');

    expect(after).toBeGreaterThanOrEqual(before);
    expect(after).toBe(before + 1);
  });

  it('applies a link before a field_update on the same game', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameId = await makeGame(owner, 'Hollow Knight', { steamAppid: null, hoursTenths: 490 });
    const runId = await makeReadyRun(owner, 1);

    // Staged field_update THEN link — insertion order deliberately reversed
    // from the required apply order, to prove the commit reorders rather
    // than trusting staging order.
    await sync.appendSyncChanges(
      owner,
      runId,
      [
        { kind: 'field_update', gameId, title: 'Hollow Knight', payload: { field: 'hoursTenths', from: 490, to: 600 } },
        { kind: 'link', gameId, title: 'Hollow Knight', payload: { steamAppid: 367520 } },
      ],
      1,
    );

    await sync.commitSyncRun(owner, runId);

    const after = await games.getGame(owner, gameId);
    expect(after.steamAppid).toBe(367520);
    expect(after.hoursTenths).toBe(600);
  });

  it('skips reconcile entirely', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameId = await makeGame(owner, 'Hollow Knight', { hoursTenths: 490 });
    const runId = await makeReadyRun(owner, 1);

    await sync.appendSyncChanges(
      owner,
      runId,
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

    const [change] = await sync.listSyncChanges(owner, runId);
    // Sanity check on the staging default this test deliberately overrides below.
    expect(change?.selected).toBe(false);

    // Force selected: true directly, bypassing the app layer entirely — this
    // test is about the COMMIT's own guard against applying a reconcile, not
    // about whether staging ever selects one.
    const { sql } = await harness();
    await sql`update game_sync_changes set selected = true where id = ${change!.id}`;

    const before = await games.getGame(owner, gameId);
    const result = await sync.commitSyncRun(owner, runId);
    const after = await games.getGame(owner, gameId);

    expect(after).toEqual(before);
    expect(result).toEqual({ applied: 0, created: 0 });
  });

  it('rejects a payload naming a non-syncable column', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameId = await makeGame(owner, 'Hollow Knight');
    const runId = await makeReadyRun(owner, 1);

    await sync.appendSyncChanges(
      owner,
      runId,
      [{ kind: 'field_update', gameId, title: 'Hollow Knight', payload: { field: 'title', from: 'Hollow Knight', to: 'Hacked' } }],
      1,
    );

    await expect(sync.commitSyncRun(owner, runId)).rejects.toThrow();

    const after = await games.getGame(owner, gameId);
    expect(after.title).toBe('Hollow Knight');
  });

  it('marks the run committed', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const runId = await makeReadyRun(owner, 0);

    await sync.commitSyncRun(owner, runId);

    const after = await sync.getSyncRun(owner, runId);
    expect(after?.status).toBe('committed');
  });

  it('rejects committing the same run twice', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const runId = await makeReadyRun(owner, 0);

    await sync.commitSyncRun(owner, runId);

    await expect(sync.commitSyncRun(owner, runId)).rejects.toBeInstanceOf(errors.SyncRunAlreadyCommittedError);
  });

  it('rejects committing a run that is still running', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameId = await makeGame(owner, 'Hollow Knight', { hoursTenths: 490 });
    // Deliberately NOT calling makeReadyRun — a fresh run defaults to 'running'.
    const run = await sync.createSyncRun(owner, 'steam', 1, []);
    await sync.appendSyncChanges(
      owner,
      run.id,
      [{ kind: 'field_update', gameId, title: 'Hollow Knight', payload: { field: 'hoursTenths', from: 490, to: 900 } }],
      1,
    );

    await expect(sync.commitSyncRun(owner, run.id)).rejects.toBeInstanceOf(errors.SyncRunNotReadyError);

    const after = await games.getGame(owner, gameId);
    expect(after.hoursTenths).toBe(490);
    const runAfter = await sync.getSyncRun(owner, run.id);
    expect(runAfter?.status).toBe('running');
  });

  it('rejects committing a run that failed', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameId = await makeGame(owner, 'Hollow Knight', { hoursTenths: 490 });
    const run = await sync.createSyncRun(owner, 'steam', 1, []);
    await sync.appendSyncChanges(
      owner,
      run.id,
      [{ kind: 'field_update', gameId, title: 'Hollow Knight', payload: { field: 'hoursTenths', from: 490, to: 900 } }],
      1,
    );
    await sync.finishSyncRun(owner, run.id, 'failed', 'Steam did not respond');

    await expect(sync.commitSyncRun(owner, run.id)).rejects.toBeInstanceOf(errors.SyncRunNotReadyError);

    const after = await games.getGame(owner, gameId);
    expect(after.hoursTenths).toBe(490);
  });

  it("rejects committing another owner's run", async () => {
    const mine = await makeOwner('mine@example.invalid');
    const theirs = await makeOwner('theirs@example.invalid');
    const gameId = await makeGame(theirs, 'Their Game', { hoursTenths: 490 });
    const runId = await makeReadyRun(theirs, 1);

    await sync.appendSyncChanges(
      theirs,
      runId,
      [{ kind: 'field_update', gameId, title: 'Their Game', payload: { field: 'hoursTenths', from: 490, to: 900 } }],
      1,
    );

    await expect(sync.commitSyncRun(mine, runId)).rejects.toThrow();

    const after = await games.getGame(theirs, gameId);
    expect(after.hoursTenths).toBe(490);
    const runAfter = await sync.getSyncRun(theirs, runId);
    expect(runAfter?.status).not.toBe('committed');
  });

  it('applies all changes in one transaction — a failure applies none', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameA = await makeGame(owner, 'Hollow Knight', { hoursTenths: 490 });
    const gameB = await makeGame(owner, 'Celeste', { hoursTenths: 100 });
    const runId = await makeReadyRun(owner, 2);

    await sync.appendSyncChanges(
      owner,
      runId,
      [
        // Valid, and staged (so ordered) FIRST — proves an already-applied
        // write inside the transaction still rolls back.
        { kind: 'field_update', gameId: gameA, title: 'Hollow Knight', payload: { field: 'hoursTenths', from: 490, to: 600 } },
        // Invalid — names a column the whitelist refuses.
        { kind: 'field_update', gameId: gameB, title: 'Celeste', payload: { field: 'title', from: 'Celeste', to: 'Hacked' } },
      ],
      2,
    );

    await expect(sync.commitSyncRun(owner, runId)).rejects.toThrow();

    const a = await games.getGame(owner, gameA);
    const b = await games.getGame(owner, gameB);
    expect(a.hoursTenths).toBe(490);
    expect(b.title).toBe('Celeste');

    const runAfter = await sync.getSyncRun(owner, runId);
    expect(runAfter?.status).not.toBe('committed');
  });

  // ───────────────────────────────────────────────────────────────────────
  // CRITICAL FIX EVIDENCE — a plain in-transaction `SELECT` does not
  // serialize against another transaction's `SELECT` under READ COMMITTED.
  // Two near-simultaneous `commitSyncRun` calls on the same run (a
  // double-click, two tabs) can both observe a non-`committed` status and
  // both proceed.
  //
  // Run against the code as of commit b107a9f (no `pg_advisory_xact_lock`),
  // a narrow version of this test — a single `new_game` change, nothing
  // else — passed 5/5 times: on a local, already-warm connection pool, the
  // FIRST transaction's short sequence of queries reliably finished (and
  // committed) before the SECOND transaction's connection was even fully
  // reserved, so the race window never actually got exercised. Widening the
  // first transaction's own work (many `field_update` changes ahead of the
  // `new_game`, each an extra sequential round trip) reopened that window
  // and reproduced the bug reliably (5/5 runs): exactly one promise
  // fulfilled and one rejected, but the rejection was a RAW, unwrapped
  // Postgres unique-violation ("Failed query: insert into games …") from
  // the `games_owner_steam_appid_idx` partial unique index — not the clean
  // `SyncRunAlreadyCommittedError` a caller can show the owner. Full
  // captured output is in the fix report appended to task-4-report.md.
  //
  // The `pg_advisory_xact_lock` below (mirroring `commitImport` in
  // `src/server/db/finance/imports.ts`) makes the second transaction BLOCK
  // until the first's commit is visible, so its own status read genuinely
  // sees `committed` and takes the typed refusal path instead — this test
  // now passes deterministically with the fix in place.
  // ───────────────────────────────────────────────────────────────────────
  it('serializes concurrent commits — exactly one succeeds, the other refuses cleanly', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const runId = await makeReadyRun(owner, 0);

    // Padding: many sequential field_update changes ahead of the new_game,
    // widening the window between the guard-check SELECT and the final
    // commit so the second transaction's own SELECT has a realistic chance
    // to land inside it. See the block comment above for why this is
    // necessary — a single-change version of this test doesn't reliably
    // reproduce the race in this environment.
    const paddingGameIds: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      paddingGameIds.push(await makeGame(owner, `Padding Game ${i}`, { hoursTenths: 10 }));
    }
    const paddingChanges = paddingGameIds.map((id, i) => ({
      kind: 'field_update' as const,
      gameId: id,
      title: `Padding Game ${i}`,
      payload: { field: 'hoursTenths', from: 10, to: 20 },
    }));

    await sync.appendSyncChanges(
      owner,
      runId,
      [
        ...paddingChanges,
        { kind: 'new_game', gameId: null, title: 'Portal 2', payload: { steamAppid: 620, hoursTenths: 80, platform: 'steam' } },
      ],
      0,
    );

    const results = await Promise.allSettled([sync.commitSyncRun(owner, runId), sync.commitSyncRun(owner, runId)]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const [loser] = rejected as PromiseRejectedResult[];
    expect(loser!.reason).toBeInstanceOf(errors.SyncRunAlreadyCommittedError);

    // Exactly one game landed — the loser's attempt never reached `games` at all.
    const created = (await games.listGames(owner)).filter((game) => game.title === 'Portal 2');
    expect(created).toHaveLength(1);
  });

  // ───────────────────────────────────────────────────────────────────────
  // PSN FIELDS (Part 3) — the whitelist and the link/new_game branches
  // extended for `psnTitleId`/`psnNpCommunicationId`/`platform`/
  // `lastPlayedAt`/`firstPlayedYear`/`platinum`. `platinum` is written HERE
  // deliberately — see `psn-plan.ts`'s module header for why PSN, and only
  // PSN, is allowed to touch it (the Steam planner never proposes it).
  // ───────────────────────────────────────────────────────────────────────

  it('applies a link naming psnTitleId and psnNpCommunicationId together', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameId = await makeGame(owner, 'Bloodborne', { platform: 'ps4', psnTitleId: null, hoursTenths: 900 });
    const runId = await makeReadyRun(owner, 1);

    await sync.appendSyncChanges(
      owner,
      runId,
      [
        {
          kind: 'link',
          gameId,
          title: 'Bloodborne',
          payload: { psnTitleId: 'CUSA00552_00', psnNpCommunicationId: 'NPWR10388_00' },
        },
      ],
      1,
    );

    await sync.commitSyncRun(owner, runId);

    const after = await games.getGame(owner, gameId);
    expect(after.psnTitleId).toBe('CUSA00552_00');
    expect(after.psnNpCommunicationId).toBe('NPWR10388_00');
  });

  it('applies field updates for platform, firstPlayedYear, lastPlayedAt and platinum', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameId = await makeGame(owner, 'Bloodborne', { platform: 'ps4', platinum: false });
    const runId = await makeReadyRun(owner, 1);

    await sync.appendSyncChanges(
      owner,
      runId,
      [
        { kind: 'field_update', gameId, title: 'Bloodborne', payload: { field: 'platform', from: 'ps4', to: 'ps5' } },
        {
          kind: 'field_update',
          gameId,
          title: 'Bloodborne',
          payload: { field: 'firstPlayedYear', from: null, to: 2015 },
        },
        {
          kind: 'field_update',
          gameId,
          title: 'Bloodborne',
          payload: { field: 'lastPlayedAt', from: null, to: '2026-08-01T00:00:00.000Z' },
        },
        { kind: 'field_update', gameId, title: 'Bloodborne', payload: { field: 'platinum', from: false, to: true } },
      ],
      1,
    );

    await sync.commitSyncRun(owner, runId);

    const after = await games.getGame(owner, gameId);
    expect(after.platform).toBe('ps5');
    expect(after.firstPlayedYear).toBe(2015);
    expect(after.lastPlayedAt?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(after.platinum).toBe(true);
  });

  it('rejects a link payload naming no linkable identity field', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameId = await makeGame(owner, 'Bloodborne', { platform: 'ps4' });
    const runId = await makeReadyRun(owner, 1);

    await sync.appendSyncChanges(
      owner,
      runId,
      [{ kind: 'link', gameId, title: 'Bloodborne', payload: { somethingElse: 'x' } }],
      1,
    );

    await expect(sync.commitSyncRun(owner, runId)).rejects.toThrow();
  });

  it('rejects a field_update naming psnTitleId — an identity field, not a plain data field', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameId = await makeGame(owner, 'Bloodborne', { platform: 'ps4' });
    const runId = await makeReadyRun(owner, 1);

    await sync.appendSyncChanges(
      owner,
      runId,
      [
        {
          kind: 'field_update',
          gameId,
          title: 'Bloodborne',
          payload: { field: 'psnTitleId', from: null, to: 'CUSA00552_00' },
        },
      ],
      1,
    );

    await expect(sync.commitSyncRun(owner, runId)).rejects.toThrow();

    const after = await games.getGame(owner, gameId);
    expect(after.psnTitleId).toBeNull();
  });

  it('rejects a field_update whose "to" does not match the field\'s own type', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const gameId = await makeGame(owner, 'Bloodborne', { platform: 'ps4' });
    const runId = await makeReadyRun(owner, 1);

    await sync.appendSyncChanges(
      owner,
      runId,
      [{ kind: 'field_update', gameId, title: 'Bloodborne', payload: { field: 'platinum', from: false, to: 'yes' } }],
      1,
    );

    await expect(sync.commitSyncRun(owner, runId)).rejects.toThrow();

    const after = await games.getGame(owner, gameId);
    expect(after.platinum).toBe(false);
  });

  it('creates a new game for a PSN new_game change, including trophy fields when matched', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const runId = await makeReadyRun(owner, 0);

    await sync.appendSyncChanges(
      owner,
      runId,
      [
        {
          kind: 'new_game',
          gameId: null,
          title: 'Returnal',
          payload: {
            psnTitleId: 'CUSA99999_00',
            hoursTenths: 300,
            platform: 'ps5',
            firstPlayedYear: 2023,
            lastPlayedAt: '2026-08-01T00:00:00.000Z',
            psnNpCommunicationId: 'NPWR99999_00',
            achievementsUnlocked: 12,
            achievementsTotal: 48,
            platinum: false,
          },
        },
      ],
      0,
    );

    await sync.commitSyncRun(owner, runId);

    const all = await games.listGames(owner);
    const created = all.find((game) => game.title === 'Returnal');
    expect(created).toMatchObject({
      psnTitleId: 'CUSA99999_00',
      hoursTenths: 300,
      platform: 'ps5',
      firstPlayedYear: 2023,
      psnNpCommunicationId: 'NPWR99999_00',
      achievementsUnlocked: 12,
      achievementsTotal: 48,
      platinum: false,
      status: 'completed',
    });
  });

  it('creates a new game for a PSN new_game change with no trophy match, carrying no trophy fields', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const runId = await makeReadyRun(owner, 0);

    await sync.appendSyncChanges(
      owner,
      runId,
      [
        {
          kind: 'new_game',
          gameId: null,
          title: 'Some Demo',
          payload: { psnTitleId: 'CUSA00001_00', hoursTenths: 0 },
        },
      ],
      0,
    );

    await sync.commitSyncRun(owner, runId);

    const all = await games.listGames(owner);
    const created = all.find((game) => game.title === 'Some Demo');
    expect(created?.psnNpCommunicationId).toBeNull();
    expect(created?.achievementsUnlocked).toBeNull();
    expect(created?.achievementsTotal).toBeNull();
    expect(created?.platinum).toBe(false);
    expect(created?.status).toBe('backlog');
  });

  it('rejects a new_game payload naming neither steamAppid nor psnTitleId', async () => {
    const owner = await makeOwner('owner@example.invalid');
    const runId = await makeReadyRun(owner, 0);

    await sync.appendSyncChanges(
      owner,
      runId,
      [{ kind: 'new_game', gameId: null, title: 'Mystery Game', payload: { hoursTenths: 10 } }],
      0,
    );

    await expect(sync.commitSyncRun(owner, runId)).rejects.toThrow();

    const all = await games.listGames(owner);
    expect(all.find((game) => game.title === 'Mystery Game')).toBeUndefined();
  });
});
