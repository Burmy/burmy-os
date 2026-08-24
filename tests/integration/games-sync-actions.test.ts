import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { countRows, harness, provisionOwner, resetDatabase } from './harness';

/**
 * The Steam sync engine (`src/features/games/sync/sync-actions.ts`) end to
 * end, against a real Postgres — matching/staging, chunking, resumability,
 * and above all the no-delete invariant a sync run must never violate.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY `next/headers` AND `next/cache` ARE BOTH MOCKED
 *
 * `requireOwner()` reads `next/headers`, Next's request-scoped accessor —
 * there is no request scope in a Vitest worker, so it is swapped for a plain
 * resolved `Headers` object, exactly like `tests/integration/owner-guard.test.ts`
 * already does. `revalidatePath()` needs Next's WORK-scoped async storage too;
 * calling it with neither present throws `Invariant: static generation store
 * missing`, so it is stubbed to a no-op — this suite is about what the action
 * WROTE to the database, not Next's own cache invalidation, which has no
 * meaningful behavior to assert outside a real server anyway. (This module
 * does not currently call `revalidatePath` itself — it stages review data,
 * nothing library-visible changes yet — but the mock is here defensively and
 * to mirror `tests/integration/games-actions.test.ts` exactly, per plan.)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const requestHeaders = { current: new Headers() };

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(requestHeaders.current),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

// No real network call ever happens in this suite — the Steam client is
// mocked at its own module boundary.
const fetchOwnedGames = vi.fn(async (): Promise<unknown[] | null> => []);
const fetchAchievementCounts = vi.fn(async (_appid: number) => null);

vi.mock('@/server/db/games/steam-client', () => ({ fetchOwnedGames, fetchAchievementCounts }));

type SyncActions = typeof import('@/features/games/sync/sync-actions');
type Games = typeof import('@/server/db/games/games');
type Sync = typeof import('@/server/db/games/sync');

let actions: SyncActions;
let games: Games;
let sync: Sync;

beforeAll(async () => {
  await harness();
  [actions, games, sync] = await Promise.all([
    import('@/features/games/sync/sync-actions'),
    import('@/server/db/games/games'),
    import('@/server/db/games/sync'),
  ]);
});

beforeEach(async () => {
  await resetDatabase();
  requestHeaders.current = new Headers();
  fetchOwnedGames.mockReset();
  fetchOwnedGames.mockImplementation(async () => []);
  fetchAchievementCounts.mockReset();
  fetchAchievementCounts.mockImplementation(async () => null);
});

/** Full raw row for a `games` id — every column, not the DAL's narrowed projection. */
async function fullGameRow(gameId: string): Promise<Record<string, unknown>> {
  const { sql } = await harness();
  const rows = await sql`select * from "games" where "id" = ${gameId}`;
  const row = rows[0];
  if (!row) throw new Error(`expected a games row for ${gameId}`);
  return row;
}

/** Starts a run and unwraps the runId, failing the test loudly if the action refused to start. */
async function startRun(): Promise<string> {
  const result = await actions.startSteamSyncAction();
  if (!result.ok || result.runId === undefined) {
    throw new Error(`expected startSteamSyncAction to succeed, got ${JSON.stringify(result)}`);
  }
  return result.runId;
}

describe('startSteamSyncAction', () => {
  it('refuses to start when Steam credentials are absent', async () => {
    await provisionOwner();
    fetchOwnedGames.mockResolvedValueOnce(null);

    const result = await actions.startSteamSyncAction();

    expect(result.ok).toBe(false);
  });

  it('creates a run covering every Steam-platform library game, not other platforms', async () => {
    const ownerId = await provisionOwner();
    await games.createGame(ownerId, { title: 'Steam Game A', platform: 'steam', status: 'completed' });
    await games.createGame(ownerId, { title: 'Steam Game B', platform: 'steam', status: 'completed' });
    await games.createGame(ownerId, { title: 'Steam Game C', platform: 'steam', status: 'completed' });
    await games.createGame(ownerId, { title: 'PSP Game D', platform: 'psp', status: 'completed' });
    await games.createGame(ownerId, { title: 'PSP Game E', platform: 'psp', status: 'completed' });

    const runId = await startRun();
    const run = await sync.getSyncRun(ownerId, runId);

    expect(run?.total).toBe(3);
  });
});

describe('advanceSteamSyncAction — the no-delete invariant', () => {
  it('leaves a library game Steam does not own completely untouched', async () => {
    const ownerId = await provisionOwner();
    const created = await games.createGame(ownerId, {
      title: 'Twisted Metal 2',
      platform: 'steam',
      status: 'completed',
      hoursTenths: 340,
      achievementsUnlocked: 12,
      achievementsTotal: 20,
    });

    // Steam's response is entirely unrelated to Twisted Metal 2.
    fetchOwnedGames.mockImplementation(async () => [{ appid: 367520, name: 'Hollow Knight', playtimeMinutes: 2940 }]);

    const before = await fullGameRow(created.id);

    const runId = await startRun();
    const progress = await actions.advanceSteamSyncAction(runId);
    if ('error' in progress) throw new Error(progress.error);
    expect(progress.done).toBe(true);

    const after = await fullGameRow(created.id);
    expect(after).toEqual(before);
    expect(await countRows('games')).toBe(1);
  });
});

describe('advanceSteamSyncAction — matching and staging', () => {
  it('stages a link for a game matched by title for the first time', async () => {
    const ownerId = await provisionOwner();
    const created = await games.createGame(ownerId, { title: 'Hollow Knight', platform: 'steam', status: 'playing' });
    fetchOwnedGames.mockImplementation(async () => [{ appid: 367520, name: 'Hollow Knight', playtimeMinutes: 2940 }]);

    const runId = await startRun();
    await actions.advanceSteamSyncAction(runId);

    const changes = await sync.listSyncChanges(ownerId, runId);
    const link = changes.find((change) => change.kind === 'link' && change.gameId === created.id);

    expect(link).toBeDefined();
    expect(link?.payload.steamAppid).toBe(367520);
  });

  it('stages a field update only when Steam-reported hours actually differ', async () => {
    const ownerId = await provisionOwner();
    const created = await games.createGame(ownerId, {
      title: 'Returnal',
      platform: 'steam',
      status: 'completed',
      steamAppid: 367520,
      hoursTenths: 490,
    });

    // 2940 minutes = 490 tenths — identical to what is already stored.
    fetchOwnedGames.mockImplementationOnce(async () => [{ appid: 367520, name: 'Returnal', playtimeMinutes: 2940 }]);
    const sameRunId = await startRun();
    await actions.advanceSteamSyncAction(sameRunId);
    const sameChanges = await sync.listSyncChanges(ownerId, sameRunId);
    expect(
      sameChanges.some(
        (change) => change.gameId === created.id && change.kind === 'field_update' && change.payload.field === 'hoursTenths',
      ),
    ).toBe(false);

    // 3060 minutes = 510 tenths — a real divergence from the stored 490.
    fetchOwnedGames.mockImplementationOnce(async () => [{ appid: 367520, name: 'Returnal', playtimeMinutes: 3060 }]);
    const diffRunId = await startRun();
    await actions.advanceSteamSyncAction(diffRunId);
    const diffChanges = await sync.listSyncChanges(ownerId, diffRunId);
    const update = diffChanges.find(
      (change) => change.gameId === created.id && change.kind === 'field_update' && change.payload.field === 'hoursTenths',
    );

    expect(update?.payload).toMatchObject({ from: 490, to: 510 });
  });

  it('stages a new_game change for a Steam-owned game with no library row', async () => {
    const ownerId = await provisionOwner();
    fetchOwnedGames.mockImplementation(async () => [
      { appid: 50, name: 'Half-Life: Opposing Force', playtimeMinutes: 438 },
    ]);

    const runId = await startRun();
    const progress = await actions.advanceSteamSyncAction(runId);
    if ('error' in progress) throw new Error(progress.error);
    expect(progress.done).toBe(true);

    const changes = await sync.listSyncChanges(ownerId, runId);
    const staged = changes.find((change) => change.kind === 'new_game' && change.title === 'Half-Life: Opposing Force');

    expect(staged).toBeDefined();
    expect(staged?.gameId).toBeNull();
    expect(staged?.payload.steamAppid).toBe(50);
  });

  it('never stages a match below the similarity floor', async () => {
    const ownerId = await provisionOwner();
    await games.createGame(ownerId, { title: 'Bloody Roar 2', platform: 'steam', status: 'backlog' });
    fetchOwnedGames.mockImplementation(async () => [{ appid: 400, name: 'Portal 2', playtimeMinutes: 100 }]);

    const runId = await startRun();
    await actions.advanceSteamSyncAction(runId);

    const changes = await sync.listSyncChanges(ownerId, runId);
    expect(changes.some((change) => change.kind === 'link')).toBe(false);
  });
});

describe('advanceSteamSyncAction — chunking and resumability', () => {
  async function seedSteamGames(ownerId: string, count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await games.createGame(ownerId, { title: `Backlog Game ${index}`, platform: 'steam', status: 'backlog' });
    }
  }

  it('advances the cursor by the chunk size and is not done mid-run', async () => {
    const ownerId = await provisionOwner();
    await seedSteamGames(ownerId, 12);

    const runId = await startRun();
    const progress = await actions.advanceSteamSyncAction(runId);
    if ('error' in progress) throw new Error(progress.error);

    expect(progress.cursor).toBe(5);
    expect(progress.total).toBe(12);
    expect(progress.done).toBe(false);
  });

  it('is resumable — a second advance continues from the stored cursor', async () => {
    const ownerId = await provisionOwner();
    await seedSteamGames(ownerId, 12);

    const runId = await startRun();
    await actions.advanceSteamSyncAction(runId);
    const second = await actions.advanceSteamSyncAction(runId);
    if ('error' in second) throw new Error(second.error);

    expect(second.cursor).toBe(10);
  });

  it('marks the run ready once the cursor reaches the total', async () => {
    const ownerId = await provisionOwner();
    await seedSteamGames(ownerId, 12);

    const runId = await startRun();
    let done = false;
    for (let i = 0; i < 10 && !done; i += 1) {
      const progress = await actions.advanceSteamSyncAction(runId);
      if ('error' in progress) throw new Error(progress.error);
      done = progress.done;
    }

    expect(done).toBe(true);
    const run = await sync.getSyncRun(ownerId, runId);
    expect(run?.status).toBe('ready');
  });
});
