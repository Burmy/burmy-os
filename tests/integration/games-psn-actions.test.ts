import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { countRows, harness, provisionOwner, resetDatabase } from './harness';

/**
 * The PSN sync engine (`src/features/games/sync/psn-actions.ts`) end to end,
 * against a real Postgres — matching/staging (both identifier spaces),
 * chunking, resumability, and above all the no-delete invariant a sync run
 * must never violate, proven specifically for PSP — a platform PSN's API can
 * never return data for.
 *
 * Mirrors `tests/integration/games-sync-actions.test.ts` structurally. See
 * that file's own doc comment for why BOTH `next/headers` and `next/cache`
 * are mocked even though this module does not currently call
 * `revalidatePath` itself.
 */

const requestHeaders = { current: new Headers() };

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(requestHeaders.current),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

// No real network call ever happens in this suite — the PSN client is
// mocked at its own module boundary, exactly like the Steam suite mocks
// `@/server/db/games/steam-client`.
const fetchPlayedTitles = vi.fn(async (): Promise<unknown> => []);
const fetchTrophyTitles = vi.fn(async (): Promise<unknown> => []);
const psnConfigured = vi.fn(() => true);
// This suite is not about token-fingerprint behaviour — see
// `tests/integration/games-sync.test.ts`'s `getPsnTokenInUseSince` describe
// block for that — so a fixed, non-null stub is enough to let
// `startPsnSyncAction` (which now calls this on every successful start)
// proceed without every existing test here having to know about it.
const currentPsnTokenFingerprint = vi.fn(() => 'fixed-test-fingerprint');

vi.mock('@/server/db/games/psn-client', () => ({
  fetchPlayedTitles,
  fetchTrophyTitles,
  psnConfigured,
  currentPsnTokenFingerprint,
}));

type PsnActions = typeof import('@/features/games/sync/psn-actions');
type Games = typeof import('@/server/db/games/games');
type Sync = typeof import('@/server/db/games/sync');

let actions: PsnActions;
let games: Games;
let sync: Sync;

beforeAll(async () => {
  await harness();
  [actions, games, sync] = await Promise.all([
    import('@/features/games/sync/psn-actions'),
    import('@/server/db/games/games'),
    import('@/server/db/games/sync'),
  ]);
});

beforeEach(async () => {
  await resetDatabase();
  requestHeaders.current = new Headers();
  fetchPlayedTitles.mockReset();
  fetchPlayedTitles.mockImplementation(async () => []);
  fetchTrophyTitles.mockReset();
  fetchTrophyTitles.mockImplementation(async () => []);
  psnConfigured.mockReset();
  psnConfigured.mockReturnValue(true);
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

/** Starts a run and unwraps the runId, failing the test loudly if the action refused to start. */
async function startRun(): Promise<string> {
  const result = await actions.startPsnSyncAction();
  if (!result.ok || result.runId === undefined) {
    throw new Error(`expected startPsnSyncAction to succeed, got ${JSON.stringify(result)}`);
  }
  return result.runId;
}

/** Runs `advancePsnSyncAction` until it reports `done`, failing loudly on any reported error. Returns the final progress. */
async function runToCompletion(runId: string, maxChunks = 20): Promise<void> {
  let done = false;
  for (let i = 0; i < maxChunks && !done; i += 1) {
    const progress = await actions.advancePsnSyncAction(runId);
    if ('error' in progress) throw new Error(progress.error);
    done = progress.done;
  }
  if (!done) throw new Error(`run ${runId} did not complete within ${maxChunks} chunks`);
}

describe('startPsnSyncAction', () => {
  it('refuses to start when PSN is not configured', async () => {
    await provisionOwner();
    fetchPlayedTitles.mockResolvedValueOnce('not_configured');

    const result = await actions.startPsnSyncAction();

    expect(result.ok).toBe(false);
    // The second fetch must never even be attempted once the first reports
    // "not configured" — same "refuse before doing partial, wasted work"
    // discipline the Steam engine's own credential pre-check documents.
    expect(fetchTrophyTitles).not.toHaveBeenCalled();
  });

  it('refuses to start with a distinct message when the PSN token has expired', async () => {
    await provisionOwner();
    fetchPlayedTitles.mockResolvedValueOnce('token_expired');

    const result = await actions.startPsnSyncAction();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/token expired/i);
  });

  it('refuses to start when PlayStation does not respond', async () => {
    await provisionOwner();
    fetchPlayedTitles.mockResolvedValueOnce('unavailable');

    const result = await actions.startPsnSyncAction();

    expect(result.ok).toBe(false);
  });

  it('refuses to start when played titles succeed but trophy titles fail', async () => {
    await provisionOwner();
    fetchPlayedTitles.mockResolvedValueOnce([]);
    fetchTrophyTitles.mockResolvedValueOnce('unavailable');

    const result = await actions.startPsnSyncAction();

    expect(result.ok).toBe(false);
  });

  it('creates a run covering every PlayStation-platform library game, not other platforms', async () => {
    const ownerId = await provisionOwner();
    await games.createGame(ownerId, { title: 'PS5 Game', platform: 'ps5', status: 'completed' });
    await games.createGame(ownerId, { title: 'PS4 Game', platform: 'ps4', status: 'completed' });
    await games.createGame(ownerId, { title: 'PSP Game', platform: 'psp', status: 'completed' });
    await games.createGame(ownerId, { title: 'Steam Game', platform: 'steam', status: 'completed' });
    await games.createGame(ownerId, { title: 'Other Game', platform: 'other', status: 'backlog' });

    const runId = await startRun();
    const run = await sync.getSyncRun(ownerId, runId);

    expect(run?.total).toBe(3);
    expect(run?.source).toBe('psn');
  });
});

describe('advancePsnSyncAction — the no-delete invariant (the owner\'s stated fear)', () => {
  it('leaves every PSP game byte-identical, and stages nothing for any of them', async () => {
    const ownerId = await provisionOwner();

    // 40 PSP games — PSN's trophy system postdates the PSP entirely, so
    // NONE of these can ever have a PSN counterpart. Mirrors the owner's
    // real library size for this platform.
    const pspGames = [];
    for (let index = 0; index < 40; index += 1) {
      const created = await games.createGame(ownerId, {
        title: `PSP Game ${index}`,
        platform: 'psp',
        status: 'completed',
        hoursTenths: 100 + index,
        rating: (index % 5) + 1,
      });
      pspGames.push(created);
    }

    // PSN's response is entirely unrelated to any PSP title.
    fetchPlayedTitles.mockImplementation(async () => [
      {
        titleId: 'CUSA00001_00',
        name: 'Returnal',
        platform: 'ps5',
        hoursTenths: 300,
        firstPlayedYear: 2023,
        lastPlayedAt: '2026-08-01T00:00:00.000Z',
      },
    ]);

    const beforeRows = new Map<string, Record<string, unknown>>();
    for (const game of pspGames) beforeRows.set(game.id, await fullGameRow(game.id));

    const runId = await startRun();
    await runToCompletion(runId, 20);

    for (const game of pspGames) {
      const after = await fullGameRow(game.id);
      expect(after).toEqual(beforeRows.get(game.id));
    }
    // No PSP row was deleted, and staging never created a new one either
    // (Returnal isn't in the library, so it stages a `new_game` — it is
    // NOT committed here, so `games` must still hold exactly the 40 seeded rows).
    expect(await countRows('games')).toBe(40);

    const changes = await sync.listSyncChanges(ownerId, runId);
    for (const game of pspGames) {
      expect(changes.some((change) => change.gameId === game.id)).toBe(false);
    }
  });

  it('does not let a same-titled PS5/PS4 re-release relabel an unlinked PSP row by name collision', async () => {
    // The real case the owner is worried about: Sony re-released "Persona 3
    // Portable" on PS5 in 2023 under the IDENTICAL title as the owner's real
    // PSP copy. A pure name match against PSN's ENTIRE played-titles list
    // (no platform filter) would score this a near-perfect match and
    // relabel the PSP row as a PS5 game — exactly the corruption
    // `categoryToPlatform` was already hardened to never cause directly
    // (it can never itself resolve `'psp'`), but which a same-titled
    // cross-platform re-release can still cause INDIRECTLY through name
    // matching alone if the PSP row is not excluded from the fallback.
    const ownerId = await provisionOwner();
    const psp = await games.createGame(ownerId, {
      title: 'Persona 3 Portable',
      platform: 'psp',
      status: 'completed',
      hoursTenths: 800,
      rating: 5,
    });

    fetchPlayedTitles.mockImplementation(async () => [
      {
        titleId: 'CUSA99999_00',
        name: 'Persona 3 Portable',
        platform: 'ps5',
        hoursTenths: 150,
        firstPlayedYear: 2024,
        lastPlayedAt: '2024-01-01T00:00:00.000Z',
      },
    ]);

    const before = await fullGameRow(psp.id);

    const runId = await startRun();
    await runToCompletion(runId, 5);

    // The PSP row is byte-identical — no link, no field_update, no platform
    // flip, nothing.
    const after = await fullGameRow(psp.id);
    expect(after).toEqual(before);

    const changes = await sync.listSyncChanges(ownerId, runId);
    expect(changes.some((change) => change.gameId === psp.id)).toBe(false);

    // The genuine PS5 title must NOT be silently absorbed into the PSP row
    // — it has to surface as its own new_game.
    const newGame = changes.find((change) => change.kind === 'new_game' && change.title === 'Persona 3 Portable');
    expect(newGame).toBeDefined();
    expect(newGame?.gameId).toBeNull();
    expect(newGame?.payload.psnTitleId).toBe('CUSA99999_00');
    expect(newGame?.payload.platform).toBe('ps5');
  });
});

describe('advancePsnSyncAction — matching and staging', () => {
  it('stages a link with psnTitleId for a game matched by title for the first time', async () => {
    const ownerId = await provisionOwner();
    const created = await games.createGame(ownerId, { title: 'Bloodborne', platform: 'ps4', status: 'playing' });
    fetchPlayedTitles.mockImplementation(async () => [
      {
        titleId: 'CUSA00552_00',
        name: 'Bloodborne',
        platform: 'ps4',
        hoursTenths: 900,
        firstPlayedYear: 2015,
        lastPlayedAt: '2015-07-10T19:40:19.000Z',
      },
    ]);

    const runId = await startRun();
    await actions.advancePsnSyncAction(runId);

    const changes = await sync.listSyncChanges(ownerId, runId);
    const link = changes.find((change) => change.kind === 'link' && change.gameId === created.id);

    expect(link).toBeDefined();
    expect(link?.payload.psnTitleId).toBe('CUSA00552_00');
  });

  it('also links psnNpCommunicationId in the same change when a confident trophy match exists', async () => {
    const ownerId = await provisionOwner();
    const created = await games.createGame(ownerId, { title: 'Bloodborne', platform: 'ps4', status: 'playing' });
    fetchPlayedTitles.mockImplementation(async () => [
      {
        titleId: 'CUSA00552_00',
        name: 'Bloodborne',
        platform: 'ps4',
        hoursTenths: 900,
        firstPlayedYear: 2015,
        lastPlayedAt: '2015-07-10T19:40:19.000Z',
      },
    ]);
    fetchTrophyTitles.mockImplementation(async () => [
      { npCommunicationId: 'NPWR10388_00', name: 'Bloodborne', earned: 30, total: 39, platinum: true },
    ]);

    const runId = await startRun();
    await actions.advancePsnSyncAction(runId);

    const changes = await sync.listSyncChanges(ownerId, runId);
    const link = changes.find((change) => change.kind === 'link' && change.gameId === created.id);

    expect(link?.payload).toEqual({ psnTitleId: 'CUSA00552_00', psnNpCommunicationId: 'NPWR10388_00' });

    const platinumUpdate = changes.find(
      (change) => change.kind === 'field_update' && change.gameId === created.id && change.payload.field === 'platinum',
    );
    expect(platinumUpdate?.payload).toMatchObject({ from: false, to: true });
  });

  it('never stages achievement or platinum data when no confident trophy match exists', async () => {
    const ownerId = await provisionOwner();
    await games.createGame(ownerId, {
      title: 'Bloodborne',
      platform: 'ps4',
      status: 'playing',
      achievementsUnlocked: 5,
      achievementsTotal: 39,
      platinum: false,
    });
    fetchPlayedTitles.mockImplementation(async () => [
      {
        titleId: 'CUSA00552_00',
        name: 'Bloodborne',
        platform: 'ps4',
        hoursTenths: 900,
        firstPlayedYear: 2015,
        lastPlayedAt: null,
      },
    ]);
    // Trophy list contains nothing resembling Bloodborne at all.
    fetchTrophyTitles.mockImplementation(async () => [
      { npCommunicationId: 'NPWR00001_00', name: 'Astro Bot', earned: 10, total: 10, platinum: true },
    ]);

    const runId = await startRun();
    await actions.advancePsnSyncAction(runId);

    const changes = await sync.listSyncChanges(ownerId, runId);
    expect(changes.some((change) => change.payload.field === 'achievementsUnlocked')).toBe(false);
    expect(changes.some((change) => change.payload.field === 'achievementsTotal')).toBe(false);
    expect(changes.some((change) => change.payload.field === 'platinum')).toBe(false);
  });

  it('stages a field update only when PSN-reported hours actually differ', async () => {
    const ownerId = await provisionOwner();
    const created = await games.createGame(ownerId, {
      title: 'Returnal',
      platform: 'ps5',
      status: 'completed',
      psnTitleId: 'CUSA00001_00',
      hoursTenths: 300,
    });

    fetchPlayedTitles.mockImplementationOnce(async () => [
      { titleId: 'CUSA00001_00', name: 'Returnal', platform: 'ps5', hoursTenths: 300, firstPlayedYear: 2023, lastPlayedAt: null },
    ]);
    const sameRunId = await startRun();
    await actions.advancePsnSyncAction(sameRunId);
    const sameChanges = await sync.listSyncChanges(ownerId, sameRunId);
    expect(
      sameChanges.some(
        (change) => change.gameId === created.id && change.kind === 'field_update' && change.payload.field === 'hoursTenths',
      ),
    ).toBe(false);

    fetchPlayedTitles.mockImplementationOnce(async () => [
      { titleId: 'CUSA00001_00', name: 'Returnal', platform: 'ps5', hoursTenths: 350, firstPlayedYear: 2023, lastPlayedAt: null },
    ]);
    const diffRunId = await startRun();
    await actions.advancePsnSyncAction(diffRunId);
    const diffChanges = await sync.listSyncChanges(ownerId, diffRunId);
    const update = diffChanges.find(
      (change) => change.gameId === created.id && change.kind === 'field_update' && change.payload.field === 'hoursTenths',
    );

    expect(update?.payload).toMatchObject({ from: 300, to: 350 });
  });

  it('stages a new_game change for a PSN-owned title with no library row', async () => {
    const ownerId = await provisionOwner();
    fetchPlayedTitles.mockImplementation(async () => [
      { titleId: 'CUSA99999_00', name: 'Astro Bot', platform: 'ps5', hoursTenths: 120, firstPlayedYear: 2024, lastPlayedAt: null },
    ]);

    const runId = await startRun();
    await runToCompletion(runId, 5);

    const changes = await sync.listSyncChanges(ownerId, runId);
    const staged = changes.find((change) => change.kind === 'new_game' && change.title === 'Astro Bot');

    expect(staged).toBeDefined();
    expect(staged?.gameId).toBeNull();
    expect(staged?.payload.psnTitleId).toBe('CUSA99999_00');
  });

  it('never maps an unrecognised PSN category to psp, and never stages a match below the similarity floor', async () => {
    const ownerId = await provisionOwner();
    await games.createGame(ownerId, { title: 'Bloody Roar 2', platform: 'psp', status: 'backlog' });
    // Nothing in this response even resembles "Bloody Roar 2".
    fetchPlayedTitles.mockImplementation(async () => [
      { titleId: 'CUSA00002_00', name: 'Portal 2', platform: 'ps4', hoursTenths: 100, firstPlayedYear: null, lastPlayedAt: null },
    ]);

    const runId = await startRun();
    await actions.advancePsnSyncAction(runId);

    const changes = await sync.listSyncChanges(ownerId, runId);
    expect(changes.some((change) => change.kind === 'link')).toBe(false);
  });
});

describe('advancePsnSyncAction — chunking and resumability', () => {
  async function seedPsnGames(ownerId: string, count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await games.createGame(ownerId, { title: `Backlog Game ${index}`, platform: 'ps5', status: 'backlog' });
    }
  }

  it('advances the cursor by the chunk size and is not done mid-run', async () => {
    const ownerId = await provisionOwner();
    await seedPsnGames(ownerId, 12);

    const runId = await startRun();
    const progress = await actions.advancePsnSyncAction(runId);
    if ('error' in progress) throw new Error(progress.error);

    expect(progress.cursor).toBe(5);
    expect(progress.total).toBe(12);
    expect(progress.done).toBe(false);
  });

  it('is resumable — a second advance continues from the stored cursor', async () => {
    const ownerId = await provisionOwner();
    await seedPsnGames(ownerId, 12);

    const runId = await startRun();
    await actions.advancePsnSyncAction(runId);
    const second = await actions.advancePsnSyncAction(runId);
    if ('error' in second) throw new Error(second.error);

    expect(second.cursor).toBe(10);
  });

  it('marks the run ready once every chunk has been processed', async () => {
    const ownerId = await provisionOwner();
    await seedPsnGames(ownerId, 12);

    const runId = await startRun();
    await runToCompletion(runId, 10);

    const run = await sync.getSyncRun(ownerId, runId);
    expect(run?.status).toBe('ready');
  });
});
