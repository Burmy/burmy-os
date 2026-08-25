import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
  // Fake-but-present credentials by default, so every test but the
  // "not configured" one below exercises the CONFIGURED path — restored by
  // `afterEach`'s `vi.unstubAllEnvs()`, same convention as
  // `tests/unit/games-steam-client.test.ts` (`restoreMocks: true` resets
  // `vi.fn()` call state between tests but does NOT undo `vi.stubEnv`).
  vi.stubEnv('STEAM_API_KEY', 'test-api-key');
  vi.stubEnv('STEAM_ID', '76561198000000000');
  fetchOwnedGames.mockReset();
  fetchOwnedGames.mockImplementation(async () => []);
  fetchAchievementCounts.mockReset();
  fetchAchievementCounts.mockImplementation(async () => null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Full raw row for a `games` id — every column, not the DAL's narrowed projection. */
async function fullGameRow(gameId: string): Promise<Record<string, unknown>> {
  const { sql } = await harness();
  const rows = await sql`select * from "games" where "id" = ${gameId}`;
  const row = rows[0];
  if (!row) throw new Error(`expected a games row for ${gameId}`);
  return row;
}

/**
 * The owner's Steam-platform game ids in the exact order the sync engine
 * walks them — determined by a raw query, independent of whatever
 * pagination implementation `listSteamGamesChunk` currently has, so this
 * stays a reliable ground truth across both the broken offset version and
 * the fixed keyset one.
 */
async function orderedSteamGameIds(ownerId: string): Promise<string[]> {
  const { sql } = await harness();
  const rows = await sql<{ id: string }[]>`
    select "id" from "games" where "owner_id" = ${ownerId} and "platform" = 'steam' order by "id" asc
  `;
  return rows.map((row) => row.id);
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
  it('refuses to start when Steam is not configured (no credentials)', async () => {
    // `fetchOwnedGames()` cannot tell this apart from a real empty library —
    // it returns `[]` for both (see `steam-client.ts`'s own doc comment) —
    // so this exercises the REAL unconfigured path via the environment,
    // deliberately NOT the mock: it does not tell the mock to return `null`
    // at all, and asserts the mock is never even called, proving the
    // refusal happens before any Steam request is attempted.
    await provisionOwner();
    vi.stubEnv('STEAM_API_KEY', undefined);
    vi.stubEnv('STEAM_ID', undefined);

    const result = await actions.startSteamSyncAction();

    expect(result.ok).toBe(false);
    expect(fetchOwnedGames).not.toHaveBeenCalled();
  });

  it('refuses to start when Steam does not respond', async () => {
    // Credentials ARE configured (beforeEach) — this is a genuine request
    // failure (network error, timeout, non-2xx, malformed JSON), which is
    // the only thing a `null` from `fetchOwnedGames()` means once
    // credentials are known to be present.
    await provisionOwner();
    fetchOwnedGames.mockResolvedValueOnce(null);

    const result = await actions.startSteamSyncAction();

    expect(result.ok).toBe(false);
  });

  it('creates a run covering every Steam-platform library game, not other platforms', async () => {
    const ownerId = await provisionOwner();
    await games.createGame(ownerId, { title: 'Steam Game A', platform: 'steam', status: 'played' });
    await games.createGame(ownerId, { title: 'Steam Game B', platform: 'steam', status: 'played' });
    await games.createGame(ownerId, { title: 'Steam Game C', platform: 'steam', status: 'played' });
    await games.createGame(ownerId, { title: 'PSP Game D', platform: 'psp', status: 'played' });
    await games.createGame(ownerId, { title: 'PSP Game E', platform: 'psp', status: 'played' });

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
      status: 'played',
      hoursTenths: 340,
      achievementsUnlocked: 12,
      achievementsTotal: 20,
    });

    // Steam's response is entirely unrelated to Twisted Metal 2.
    fetchOwnedGames.mockImplementation(async () => [{ appid: 367520, name: 'Hollow Knight', playtimeMinutes: 2940 }]);

    const before = await fullGameRow(created.id);

    const runId = await startRun();
    // "Done" is an EMPTY chunk (see advanceSteamSyncAction's own doc
    // comment) — the one real library game is consumed by the first call,
    // but a second, empty call is what actually signals completion.
    let done = false;
    for (let i = 0; i < 5 && !done; i += 1) {
      const progress = await actions.advanceSteamSyncAction(runId);
      if ('error' in progress) throw new Error(progress.error);
      done = progress.done;
    }
    expect(done).toBe(true);

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
      status: 'played',
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

describe('advanceSteamSyncAction — keyset pagination survives a moving library', () => {
  it('reaches ready even when a not-yet-processed game is deleted mid-run', async () => {
    const ownerId = await provisionOwner();
    for (let index = 0; index < 8; index += 1) {
      await games.createGame(ownerId, { title: `Delete Test Game ${index}`, platform: 'steam', status: 'backlog' });
    }
    const orderedIds = await orderedSteamGameIds(ownerId);
    expect(orderedIds).toHaveLength(8);

    const runId = await startRun();

    // First chunk (CHUNK_SIZE = 5) consumes orderedIds[0..4].
    const first = await actions.advanceSteamSyncAction(runId);
    if ('error' in first) throw new Error(first.error);
    expect(first.done).toBe(false);

    // Delete one of the three NOT-YET-PROCESSED games (orderedIds[5..7]) —
    // this is what stranded the old offset/total implementation: `total`
    // stays frozen at 8 but only 7 rows remain, so the cursor could never
    // reach it.
    const notYetProcessed = orderedIds[5];
    if (notYetProcessed === undefined) throw new Error('expected a not-yet-processed game id');
    await games.deleteGame(ownerId, notYetProcessed);

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

  it('never stages a duplicate change when a game is inserted mid-run', async () => {
    const ownerId = await provisionOwner();
    const titles: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const title = `Insert Test Game ${index}`;
      titles.push(title);
      await games.createGame(ownerId, { title, platform: 'steam', status: 'backlog' });
    }
    const orderedIds = await orderedSteamGameIds(ownerId);
    expect(orderedIds).toHaveLength(8);

    // Steam owns every seeded title, plus the game inserted mid-run below —
    // exact title matches so every processed game stages a `link` change,
    // which makes a duplicate easy to detect.
    const midRunTitle = 'Mid-Run New Game';
    fetchOwnedGames.mockImplementation(async () =>
      [...titles, midRunTitle].map((name, index) => ({ appid: 1000 + index, name, playtimeMinutes: 60 })),
    );

    const runId = await startRun();

    const first = await actions.advanceSteamSyncAction(runId);
    if ('error' in first) throw new Error(first.error);
    expect(first.done).toBe(false);

    // Insert a game whose id sorts BEFORE every already-seeded row —
    // the exact reproduced shape: an id landing behind the pagination
    // window instead of ahead of it. A real `defaultRandom()` id cannot be
    // controlled from here, so this bypasses the DAL with a raw insert
    // carrying an explicit, deliberately minimal id — test setup only,
    // never a pattern application code should follow.
    const { sql } = await harness();
    const midRunGameId = '00000000-0000-0000-0000-000000000001';
    await sql`
      insert into "games" ("id", "owner_id", "title", "platform", "status")
      values (${midRunGameId}, ${ownerId}, ${midRunTitle}, 'steam', 'backlog')
    `;

    let done = false;
    for (let i = 0; i < 10 && !done; i += 1) {
      const progress = await actions.advanceSteamSyncAction(runId);
      if ('error' in progress) throw new Error(progress.error);
      done = progress.done;
    }
    expect(done).toBe(true);

    const changes = await sync.listSyncChanges(ownerId, runId);
    const linkChangeCountByGame = new Map<string, number>();
    for (const change of changes) {
      if (change.kind !== 'link' || change.gameId === null) continue;
      linkChangeCountByGame.set(change.gameId, (linkChangeCountByGame.get(change.gameId) ?? 0) + 1);
    }

    for (const [gameId, count] of linkChangeCountByGame) {
      expect(count, `game ${gameId} received ${count} link changes, expected at most 1`).toBeLessThanOrEqual(1);
    }
  });
});
