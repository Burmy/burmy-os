import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GameSuggestion } from '@/server/games/metadata';
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
/**
 * The sync now reads achievement DETAIL, not just counts, so that one response
 * can feed both the stored count columns and the stored trophy rows — see
 * `fetchAchievementDetail`'s own doc comment on why those must not come from
 * two separate requests. `null` by default: most tests here are about matching
 * and staging, not achievements.
 */
const fetchAchievementDetail = vi.fn(async (_appid: number): Promise<unknown> => null);

vi.mock('@/server/db/games/steam-client', () => ({ fetchOwnedGames, fetchAchievementDetail }));

// The enrichment phase's one HTTP boundary — mocked here for the same reason
// the Steam client is: this suite exercises what `advanceSyncEnrichmentAction`
// does with a GIVEN `searchGames` result, never a real IGDB/Twitch call.
const searchGames = vi.fn(async (_title: string): Promise<GameSuggestion[]> => []);

vi.mock('@/server/db/games/igdb', () => ({ searchGames }));

type SyncActions = typeof import('@/features/games/sync/sync-actions');
type Games = typeof import('@/server/db/games/games');
type Sync = typeof import('@/server/db/games/sync');
type TrophiesDb = typeof import('@/server/db/games/trophies');

let actions: SyncActions;
let games: Games;
let sync: Sync;
let trophiesDb: TrophiesDb;

beforeAll(async () => {
  await harness();
  [actions, games, sync, trophiesDb] = await Promise.all([
    import('@/features/games/sync/sync-actions'),
    import('@/server/db/games/games'),
    import('@/server/db/games/sync'),
    import('@/server/db/games/trophies'),
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
  fetchAchievementDetail.mockReset();
  fetchAchievementDetail.mockImplementation(async () => null);
  searchGames.mockReset();
  searchGames.mockImplementation(async () => []);
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

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * A TITLE INSIDE A COLLECTION IS INVISIBLE TO A SYNC.
 *
 * The collection row carries the Steam identity, the hours and the trophies;
 * the titles inside it exist to be counted, rated and illustrated. No Steam
 * or PSN response will ever be about one of them.
 *
 * Left visible, an unlinked child is name-matched like any other row — and
 * `bestTitleMatchAmong` would score it against the collection's own library
 * entry, stage a `link` pointing the child at its parent's appid, then
 * `field_update` the collection's hours onto it. The same 44h would then
 * exist on two rows and every SUM in `stats.ts` would count it twice.
 *
 * This is the same class of guard as the unlinked-PSP rule in
 * `resolvePlayedTitle` (`psn-actions.ts`), and it gets the same treatment:
 * a named invariant test that MUTATION-FAILS if the guard is removed. The
 * scenario is deliberately the hostile one — Steam reporting a game whose
 * name is an EXACT match for the child — because a test where the names
 * merely differ would pass with or without the guard and prove nothing.
 * ─────────────────────────────────────────────────────────────────────────────
 */
describe('advanceSteamSyncAction — collection members are invisible to a sync', () => {
  it('never touches a title inside a collection, even when Steam owns a game by that exact name', async () => {
    const ownerId = await provisionOwner();
    const collection = await games.createGame(ownerId, {
      title: 'Uncharted: The Nathan Drake Collection',
      platform: 'steam',
      status: 'played',
      hoursTenths: 440,
    });
    const member = await games.createGame(ownerId, {
      title: 'Uncharted 2: Among Thieves Remastered',
      platform: 'steam',
      status: 'played',
      collectionId: collection.id,
    });

    // The hostile case: Steam's entry is an EXACT title match for the child.
    // Without the guard this links the child and copies hours onto it.
    fetchOwnedGames.mockImplementation(async () => [
      { appid: 999001, name: 'Uncharted 2: Among Thieves Remastered', playtimeMinutes: 600 },
    ]);

    const before = await fullGameRow(member.id);

    const runId = await startRun();
    let done = false;
    for (let i = 0; i < 5 && !done; i += 1) {
      const progress = await actions.advanceSteamSyncAction(runId);
      if ('error' in progress) throw new Error(progress.error);
      done = progress.done;
    }
    expect(done).toBe(true);

    // Byte-identical: no link, no field update, no write of any kind.
    expect(await fullGameRow(member.id)).toEqual(before);

    // ...and nothing was even PROPOSED against it.
    const changes = await sync.listSyncChanges(ownerId, runId);
    expect(changes.filter((change) => change.gameId === member.id)).toEqual([]);

    // Note on what DOES happen to that Steam entry: with the child invisible,
    // no library row accounts for appid 999001, so it is staged as a
    // `new_game` for the owner to accept or decline. That is correct — a
    // separately-owned Steam copy of a game you also have inside a boxed
    // collection is genuinely a second thing — and it stays a proposal either
    // way, never a write. In the owner's real data this does not arise at
    // all: Steam sells the collection under one appid, not three.
  });

  it('still walks and syncs the COLLECTION row itself, which is where the Steam identity lives', async () => {
    const ownerId = await provisionOwner();
    const collection = await games.createGame(ownerId, {
      title: 'Uncharted: The Nathan Drake Collection',
      platform: 'steam',
      status: 'played',
    });
    await games.createGame(ownerId, {
      title: "Uncharted: Drake's Fortune Remastered",
      platform: 'steam',
      status: 'played',
      collectionId: collection.id,
    });

    fetchOwnedGames.mockImplementation(async () => [
      { appid: 999002, name: 'Uncharted: The Nathan Drake Collection', playtimeMinutes: 2640 },
    ]);

    const runId = await startRun();
    let done = false;
    for (let i = 0; i < 5 && !done; i += 1) {
      const progress = await actions.advanceSteamSyncAction(runId);
      if ('error' in progress) throw new Error(progress.error);
      done = progress.done;
    }
    expect(done).toBe(true);

    // The guard excludes CHILDREN, not collections — the wrapper must still
    // link normally, or the feature would sever every collection from its
    // own sync.
    const changes = await sync.listSyncChanges(ownerId, runId);
    const link = changes.find((change) => change.kind === 'link' && change.gameId === collection.id);
    expect(link?.payload.steamAppid).toBe(999002);
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

  /**
   * ─────────────────────────────────────────────────────────────────────────
   * TROPHIES ARE WRITTEN, NOT STAGED.
   *
   * Everything else this sync produces lands in `sync_changes` for the owner
   * to approve, because every field it touches is one they can type
   * themselves. An individual earned achievement has no owner-authored
   * counterpart — it is a fact about the past — so it goes straight to
   * `game_trophies` and never appears as a proposal.
   *
   * This asserts both halves: rows exist afterwards, and NOTHING about them
   * was staged for review.
   * ─────────────────────────────────────────────────────────────────────────
   */
  it('writes achievements straight to game_trophies without staging them', async () => {
    const ownerId = await provisionOwner();
    const created = await games.createGame(ownerId, {
      title: 'Hollow Knight',
      platform: 'steam',
      steamAppid: 367520,
    });

    fetchOwnedGames.mockImplementationOnce(async () => [
      { appid: 367520, name: 'Hollow Knight', playtimeMinutes: 2940, lastPlayedAt: null },
    ]);
    fetchAchievementDetail.mockImplementationOnce(async () => ({
      achievements: [
        { apiname: 'CHARMED', name: 'Charmed', description: 'Acquire your first Charm', unlocked: true, unlockTime: 1_735_010_079 },
        { apiname: 'ZOTE', name: 'Rivalry', description: null, unlocked: false, unlockTime: 0 },
      ],
      counts: { unlocked: 1, total: 2 },
      rarity: new Map([['CHARMED', '76.8']]),
    }));

    const runId = await startRun();
    await actions.advanceSteamSyncAction(runId);

    const stored = await trophiesDb.listGameTrophies(ownerId, created.id);
    expect(stored).toHaveLength(2);

    const charmed = stored.find((t) => t.id === 'CHARMED');
    expect(charmed).toMatchObject({ source: 'steam', name: 'Charmed', earned: true, rarityTenths: 768, tier: null });
    expect(charmed?.earnedAt).toBe('2024-12-24T03:14:39.000Z');

    // Steam's never-unlocked sentinel must not become a 1970 timestamp.
    expect(stored.find((t) => t.id === 'ZOTE')).toMatchObject({ earned: false, earnedAt: null, rarityTenths: null });

    const changes = await sync.listSyncChanges(ownerId, runId);
    expect(changes.some((change) => JSON.stringify(change.payload).includes('CHARMED'))).toBe(false);
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

/** A minimal, fully-specified `GameSuggestion` fixture — same shape as the unit suite's own helper. */
function suggestion(overrides: Partial<GameSuggestion> & { title: string }): GameSuggestion {
  return {
    externalId: '1',
    coverUrl: null,
    genre: null,
    developer: null,
    publisher: null,
    metacritic: null,
    averagePlaytimeHours: null,
    esrbRating: null,
    releaseYear: null,
    ...overrides,
  };
}

/** The one `games` row for this title, by raw query — new_game rows have no id to look up by beforehand. */
async function gameRowByTitle(ownerId: string, title: string): Promise<Record<string, unknown>> {
  const { sql } = await harness();
  const rows = await sql`select * from "games" where "owner_id" = ${ownerId} and "title" = ${title}`;
  const row = rows[0];
  if (!row) throw new Error(`expected a games row titled "${title}"`);
  return row;
}

/** Drives a run's staging phase to `ready`, same "empty chunk is done" loop every other test in this file uses. */
async function runToReady(runId: string): Promise<void> {
  let done = false;
  for (let i = 0; i < 50 && !done; i += 1) {
    const progress = await actions.advanceSteamSyncAction(runId);
    if ('error' in progress) throw new Error(progress.error);
    done = progress.done;
  }
  if (!done) throw new Error('sync run never reached done');
}

/**
 * Drives the enrichment phase to `done` — the SAME "an empty chunk is the
 * only done signal" idiom `runToReady` above uses for staging, since
 * `advanceSyncEnrichmentAction` follows it too (see that function's own doc
 * comment): a chunk that processed real changes is not yet `done` on its
 * own, even when fewer than `ENRICHMENT_CHUNK_SIZE` remained — the FOLLOWING
 * call, seeing nothing left, is what actually reports `done: true`. Returns
 * the number of calls made and the total changes enriched across all of
 * them, so a test can assert on both the outcome and the chunking shape.
 */
async function enrichToDone(runId: string): Promise<{ readonly calls: number; readonly totalEnriched: number }> {
  let done = false;
  let calls = 0;
  let totalEnriched = 0;
  for (let i = 0; i < 50 && !done; i += 1) {
    const progress = await actions.advanceSyncEnrichmentAction(runId);
    if ('error' in progress) throw new Error(progress.error);
    calls += 1;
    totalEnriched += progress.enrichedCount;
    done = progress.done;
  }
  if (!done) throw new Error('enrichment never reached done');
  return { calls, totalEnriched };
}

describe('advanceSyncEnrichmentAction', () => {
  it('fills a staged new_game change with IGDB metadata on a HIGH-confidence match, and commit carries it through to the games row', async () => {
    const ownerId = await provisionOwner();
    fetchOwnedGames.mockImplementation(async () => [{ appid: 1001, name: 'Elden Ring', playtimeMinutes: 6000 }]);
    searchGames.mockImplementation(async (title) =>
      title === 'Elden Ring'
        ? [
            suggestion({
              title: 'Elden Ring', // identical normalized title — HIGH confidence
              coverUrl: 'https://images.igdb.com/elden-ring.jpg',
              genre: 'RPG',
              metacritic: 95,
              averagePlaytimeHours: 55,
              esrbRating: 'M',
            }),
          ]
        : [],
    );

    const runId = await startRun();
    await runToReady(runId);

    const { totalEnriched } = await enrichToDone(runId);
    expect(totalEnriched).toBe(1);

    const changes = await sync.listSyncChanges(ownerId, runId);
    const staged = changes.find((change) => change.kind === 'new_game' && change.title === 'Elden Ring');
    expect(staged?.payload).toMatchObject({
      coverUrl: 'https://images.igdb.com/elden-ring.jpg',
      genre: 'RPG',
      metacritic: 95,
      averagePlaytimeHours: 55,
      esrbRating: 'M',
      metadataEnriched: true,
      // The identity/hours fields the planner staged must survive the merge untouched.
      steamAppid: 1001,
      hoursTenths: 1000,
    });

    const commit = await sync.commitSyncRun(ownerId, runId);
    expect(commit.created).toBe(1);

    const row = await gameRowByTitle(ownerId, 'Elden Ring');
    expect(row.cover_url).toBe('https://images.igdb.com/elden-ring.jpg');
    expect(row.genre).toBe('RPG');
    expect(row.metacritic).toBe(95);
    expect(row.average_playtime_hours).toBe(55);
    expect(row.esrb_rating).toBe('M');
  });

  it('leaves a staged new_game change usable — no metadata, but still committable — when IGDB returns no confident match', async () => {
    const ownerId = await provisionOwner();
    fetchOwnedGames.mockImplementation(async () => [{ appid: 1002, name: 'Some New Indie Game', playtimeMinutes: 120 }]);
    // A wholly unrelated suggestion — the real "closest neighbour, still
    // below the floor" shape `SIMILARITY_FLOOR` is calibrated against.
    searchGames.mockImplementation(async () => [suggestion({ title: 'Totally Unrelated Title' })]);

    const runId = await startRun();
    await runToReady(runId);

    const { totalEnriched } = await enrichToDone(runId);
    expect(totalEnriched).toBe(1);

    const changes = await sync.listSyncChanges(ownerId, runId);
    const staged = changes.find((change) => change.kind === 'new_game' && change.title === 'Some New Indie Game');
    expect(staged?.payload.metadataEnriched).toBe(true);
    expect(staged?.payload.coverUrl).toBeUndefined();
    expect(staged?.payload.genre).toBeUndefined();
    // The change is not stuck or dropped — its real staged fields are intact.
    expect(staged?.payload.steamAppid).toBe(1002);

    const commit = await sync.commitSyncRun(ownerId, runId);
    expect(commit.created).toBe(1);

    const row = await gameRowByTitle(ownerId, 'Some New Indie Game');
    expect(row.cover_url).toBeNull();
    expect(row.genre).toBeNull();
    expect(row.steam_appid).toBe(1002);
  });

  it('never fails the run when IGDB is entirely unreachable, even across several staged games spanning more than one chunk', async () => {
    const ownerId = await provisionOwner();
    // Four new games — one more than ENRICHMENT_CHUNK_SIZE (3) — so this
    // also proves the chunked walk itself keeps going across calls.
    fetchOwnedGames.mockImplementation(async () => [
      { appid: 2001, name: 'New Game One', playtimeMinutes: 60 },
      { appid: 2002, name: 'New Game Two', playtimeMinutes: 60 },
      { appid: 2003, name: 'New Game Three', playtimeMinutes: 60 },
      { appid: 2004, name: 'New Game Four', playtimeMinutes: 60 },
    ]);
    // IGDB "entirely down" — searchGames itself already soft-fails to `[]`
    // for every credentials/network/response failure (see `igdb.ts`), so
    // this is the exact value a real outage produces.
    searchGames.mockImplementation(async () => []);

    const runId = await startRun();
    await runToReady(runId);

    let done = false;
    let totalEnriched = 0;
    let calls = 0;
    for (let i = 0; i < 10 && !done; i += 1) {
      const progress = await actions.advanceSyncEnrichmentAction(runId);
      if ('error' in progress) throw new Error(progress.error);
      calls += 1;
      totalEnriched += progress.enrichedCount;
      done = progress.done;

      // The run must never flip to 'failed' partway through enrichment.
      const run = await sync.getSyncRun(ownerId, runId);
      expect(run?.status).toBe('ready');
    }

    expect(done).toBe(true);
    expect(totalEnriched).toBe(4);
    expect(calls).toBeGreaterThan(1); // proves it actually spanned more than one chunk

    const run = await sync.getSyncRun(ownerId, runId);
    expect(run?.status).toBe('ready');

    const commit = await sync.commitSyncRun(ownerId, runId);
    expect(commit.created).toBe(4);

    for (const title of ['New Game One', 'New Game Two', 'New Game Three', 'New Game Four']) {
      const row = await gameRowByTitle(ownerId, title);
      expect(row.cover_url).toBeNull();
    }
  });
});
