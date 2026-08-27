import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { harness, resetDatabase } from './harness';

/**
 * `game_trophies` against real Postgres — the upsert contract, owner scoping,
 * and the four aggregate views the Stats page reads.
 *
 * Every aggregate here is computed in SQL, so these tests are the only place
 * that behaviour is actually exercised: a unit test over in-memory rows would
 * verify a different implementation than the one that ships.
 */

type TrophiesDb = typeof import('@/server/db/games/trophies');
type Games = typeof import('@/server/db/games/games');
type Trophy = import('@/server/games/trophies').Trophy;

let trophies: TrophiesDb;
let games: Games;

beforeAll(async () => {
  await harness();
  [trophies, games] = await Promise.all([
    import('@/server/db/games/trophies'),
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

function trophy(overrides: Partial<Trophy> = {}): Trophy {
  return {
    source: 'psn',
    id: '1',
    groupId: 'default',
    tier: 'bronze',
    hidden: false,
    name: 'First Steps',
    description: 'Begin the game.',
    iconUrl: null,
    earned: false,
    earnedAt: null,
    rarityTenths: 500,
    ...overrides,
  };
}

/**
 * A PSN trophy list of `total` trophies where the first `earned` are unlocked.
 *
 * The platinum is the LAST index, not the first — that is how PlayStation
 * actually works (it unlocks when everything else does) and it is what makes
 * a partially-complete list qualify as "close to platinum". With the platinum
 * at index 0 it was always earned, so no fixture could ever be close to one.
 */
function psnList(total: number, earned: number): Trophy[] {
  return Array.from({ length: total }, (_, index) =>
    trophy({
      id: String(index),
      tier: index === total - 1 ? 'platinum' : 'bronze',
      name: `Trophy ${index}`,
      earned: index < earned,
      // Offset from a fixed instant rather than composing a date string —
      // `2026-08-${10 + index}` produced `2026-08-60` for a 50-trophy list and
      // failed inside the driver, not in an assertion.
      earnedAt: index < earned ? new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString() : null,
      rarityTenths: 100 + index,
    }),
  );
}

describe('replaceGameTrophies', () => {
  it('stores a game trophies and reads them back', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const game = await games.createGame(owner, { title: 'Bloodborne', platform: 'ps4' });

    await trophies.replaceGameTrophies(owner, game.id, 'psn', [trophy({ earned: true, earnedAt: '2026-08-20T00:00:00.000Z' })]);

    const stored = await trophies.listGameTrophies(owner, game.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ source: 'psn', id: '1', tier: 'bronze', earned: true, rarityTenths: 500 });
  });

  /**
   * The unique index is what makes a re-sync an update rather than a duplicate.
   * Without it, every sync would multiply the library.
   */
  it('upserts on re-sync rather than duplicating', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const game = await games.createGame(owner, { title: 'Bloodborne', platform: 'ps4' });

    await trophies.replaceGameTrophies(owner, game.id, 'psn', [trophy({ earned: false })]);
    await trophies.replaceGameTrophies(owner, game.id, 'psn', [trophy({ earned: true, earnedAt: '2026-08-21T00:00:00.000Z' })]);

    const stored = await trophies.listGameTrophies(owner, game.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.earned).toBe(true);
  });

  /**
   * An empty set means the source told us nothing — a failed fetch, an expired
   * token — never "this game has no trophies any more." Wiping a real list on
   * a transient failure is the specific accident this guards.
   */
  it('leaves stored trophies alone when handed an empty set', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const game = await games.createGame(owner, { title: 'Bloodborne', platform: 'ps4' });

    await trophies.replaceGameTrophies(owner, game.id, 'psn', [trophy()]);
    await trophies.replaceGameTrophies(owner, game.id, 'psn', []);

    expect(await trophies.listGameTrophies(owner, game.id)).toHaveLength(1);
  });

  it('removes a trophy the source no longer defines', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const game = await games.createGame(owner, { title: 'Bloodborne', platform: 'ps4' });

    await trophies.replaceGameTrophies(owner, game.id, 'psn', [trophy({ id: '1' }), trophy({ id: '2' })]);
    await trophies.replaceGameTrophies(owner, game.id, 'psn', [trophy({ id: '1' })]);

    expect((await trophies.listGameTrophies(owner, game.id)).map((t) => t.id)).toEqual(['1']);
  });

  /** A PSN sync must never delete the Steam rows of a game that carries both. */
  it('never deletes another source rows for the same game', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const game = await games.createGame(owner, { title: 'Hybrid', platform: 'ps5' });

    await trophies.replaceGameTrophies(owner, game.id, 'steam', [trophy({ source: 'steam', id: 'CHARMED', tier: null, groupId: null })]);
    await trophies.replaceGameTrophies(owner, game.id, 'psn', [trophy({ id: '1' })]);

    const stored = await trophies.listGameTrophies(owner, game.id);
    expect(stored.map((t) => t.source).sort()).toEqual(['psn', 'steam']);
  });

  it('cascades when the game is deleted', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const game = await games.createGame(owner, { title: 'Bloodborne', platform: 'ps4' });
    await trophies.replaceGameTrophies(owner, game.id, 'psn', [trophy()]);

    await games.deleteGame(owner, game.id);

    expect(await trophies.listGameTrophies(owner, game.id)).toHaveLength(0);
  });
});

describe('listCloseToPlatinum', () => {
  it('orders by trophies remaining, nearest first', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const near = await games.createGame(owner, { title: 'Nearly There', platform: 'ps5' });
    const far = await games.createGame(owner, { title: 'Long Way', platform: 'ps5' });

    await trophies.replaceGameTrophies(owner, near.id, 'psn', psnList(35, 32)); // 3 left
    await trophies.replaceGameTrophies(owner, far.id, 'psn', psnList(50, 20)); // 30 left

    const rows = await trophies.listCloseToPlatinum(owner);
    expect(rows.map((r) => r.title)).toEqual(['Nearly There', 'Long Way']);
    expect(rows[0]).toMatchObject({ earned: 32, total: 35, remaining: 3 });
  });

  /** The platinum is the point. A game that has already been platinumed is finished, not close. */
  it('excludes a game whose platinum is already earned', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const done = await games.createGame(owner, { title: 'Platinumed', platform: 'ps5' });
    await trophies.replaceGameTrophies(owner, done.id, 'psn', psnList(10, 10));

    expect(await trophies.listCloseToPlatinum(owner)).toHaveLength(0);
  });

  /**
   * A title that defines no platinum at all (some PS4 games, DLC-only lists)
   * can never be "close to" one. Qualifying on an unearned platinum EXISTING,
   * rather than on "not yet 100%", is what keeps those out.
   */
  it('excludes a game with no platinum trophy defined', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const game = await games.createGame(owner, { title: 'No Platinum', platform: 'ps4' });
    await trophies.replaceGameTrophies(owner, game.id, 'psn', [
      trophy({ id: '1', tier: 'gold', earned: false }),
      trophy({ id: '2', tier: 'bronze', earned: true, earnedAt: '2026-08-01T00:00:00.000Z' }),
    ]);

    expect(await trophies.listCloseToPlatinum(owner)).toHaveLength(0);
  });

  /** Steam has no platinum. Including it would invent a milestone the platform does not have. */
  it('excludes Steam games entirely', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const game = await games.createGame(owner, { title: 'Hollow Knight', platform: 'steam' });
    await trophies.replaceGameTrophies(
      owner,
      game.id,
      'steam',
      psnList(20, 18).map((t) => ({ ...t, source: 'steam' as const, tier: null, groupId: null })),
    );

    expect(await trophies.listCloseToPlatinum(owner)).toHaveLength(0);
  });
});

describe('listRecentlyEarned', () => {
  it('returns the newest unlocks first, across both sources', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const ps = await games.createGame(owner, { title: 'PS Game', platform: 'ps5' });
    const steam = await games.createGame(owner, { title: 'Steam Game', platform: 'steam' });

    await trophies.replaceGameTrophies(owner, ps.id, 'psn', [
      trophy({ id: '1', name: 'Older', earned: true, earnedAt: '2026-08-01T00:00:00.000Z' }),
    ]);
    await trophies.replaceGameTrophies(owner, steam.id, 'steam', [
      trophy({ id: 'NEW', source: 'steam', tier: null, groupId: null, name: 'Newer', earned: true, earnedAt: '2026-08-25T00:00:00.000Z' }),
    ]);

    const rows = await trophies.listRecentlyEarned(owner);
    expect(rows.map((r) => r.name)).toEqual(['Newer', 'Older']);
    expect(rows[0]?.gameTitle).toBe('Steam Game');
  });

  it('excludes unearned trophies and earned ones with no date', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const game = await games.createGame(owner, { title: 'Mixed', platform: 'ps5' });
    await trophies.replaceGameTrophies(owner, game.id, 'psn', [
      trophy({ id: '1', name: 'Unearned', earned: false }),
      // Reachable in real data: Steam reports `unlocktime` 0 for some very old
      // unlocks, so `earned` is true with no date. It cannot be placed on a
      // timeline, so it is left off rather than floated to one end.
      trophy({ id: '2', name: 'No date', earned: true, earnedAt: null }),
      trophy({ id: '3', name: 'Dated', earned: true, earnedAt: '2026-08-20T00:00:00.000Z' }),
    ]);

    expect((await trophies.listRecentlyEarned(owner)).map((r) => r.name)).toEqual(['Dated']);
  });
});

describe('listRarestEarned', () => {
  it('returns the lowest rarity first, and only earned trophies', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const game = await games.createGame(owner, { title: 'Rare Things', platform: 'ps5' });
    await trophies.replaceGameTrophies(owner, game.id, 'psn', [
      trophy({ id: '1', name: 'Common', earned: true, earnedAt: '2026-08-01T00:00:00.000Z', rarityTenths: 768 }),
      trophy({ id: '2', name: 'Rare', earned: true, earnedAt: '2026-08-02T00:00:00.000Z', rarityTenths: 4 }),
      trophy({ id: '3', name: 'Rarest but unearned', earned: false, rarityTenths: 1 }),
    ]);

    expect((await trophies.listRarestEarned(owner)).map((r) => r.name)).toEqual(['Rare', 'Common']);
  });

  /** A null rarity must not sort as "rarest" — unknown is not zero. */
  it('excludes trophies with no reported rarity', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const game = await games.createGame(owner, { title: 'Unknown', platform: 'ps5' });
    await trophies.replaceGameTrophies(owner, game.id, 'psn', [
      trophy({ id: '1', name: 'No rarity', earned: true, earnedAt: '2026-08-01T00:00:00.000Z', rarityTenths: null }),
      trophy({ id: '2', name: 'Has rarity', earned: true, earnedAt: '2026-08-02T00:00:00.000Z', rarityTenths: 300 }),
    ]);

    expect((await trophies.listRarestEarned(owner)).map((r) => r.name)).toEqual(['Has rarity']);
  });
});

describe('getCompletionSummary', () => {
  it('counts every trophy across both sources, and games separately', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const complete = await games.createGame(owner, { title: 'Complete', platform: 'ps5' });
    const nearly = await games.createGame(owner, { title: 'Nearly', platform: 'steam' });

    await trophies.replaceGameTrophies(owner, complete.id, 'psn', psnList(10, 10));
    await trophies.replaceGameTrophies(
      owner,
      nearly.id,
      'steam',
      psnList(10, 9).map((t) => ({ ...t, source: 'steam' as const, tier: null, groupId: null })),
    );

    const summary = await trophies.getCompletionSummary(owner);
    expect(summary).toMatchObject({
      earned: 19,
      total: 20,
      percent: 95,
      trackedGames: 2,
      completeGames: 1,
      nearlyCompleteGames: 1,
    });
  });

  /** `null`, not `0` — "nothing is tracked" must not read as "you have earned nothing." */
  it('reports a null percent when nothing is tracked at all', async () => {
    const owner = await makeOwner('owner@burmy.test');
    expect(await trophies.getCompletionSummary(owner)).toMatchObject({ percent: null, total: 0, trackedGames: 0 });
  });
});

describe('owner scoping', () => {
  it('never returns another owner trophies from any view', async () => {
    const mine = await makeOwner('mine@burmy.test');
    const theirs = await makeOwner('theirs@burmy.test');
    const theirGame = await games.createGame(theirs, { title: 'Theirs', platform: 'ps5' });
    await trophies.replaceGameTrophies(theirs, theirGame.id, 'psn', psnList(10, 5));

    expect(await trophies.listGameTrophies(mine, theirGame.id)).toHaveLength(0);
    expect(await trophies.listCloseToPlatinum(mine)).toHaveLength(0);
    expect(await trophies.listRecentlyEarned(mine)).toHaveLength(0);
    expect(await trophies.listRarestEarned(mine)).toHaveLength(0);
    expect(await trophies.getCompletionSummary(mine)).toMatchObject({ total: 0, trackedGames: 0 });
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DRIFT CHECK.
 *
 * `games.achievements_unlocked`/`achievements_total` and the rows in
 * `game_trophies` now state the same fact twice. That is a genuine
 * two-sources-of-truth risk, and the mitigation is structural:
 * `fetchAchievementDetail` derives both from ONE `GetPlayerAchievements`
 * response, so they cannot observe different moments.
 *
 * This asserts the invariant that mitigation exists to protect. It belongs in
 * the suite rather than in a code comment, because the comment cannot fail.
 * ─────────────────────────────────────────────────────────────────────────────
 */
describe('stored counts agree with stored rows', () => {
  it('matches games.achievements_* to the trophy rows for the same game', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const game = await games.createGame(owner, { title: 'Hollow Knight', platform: 'steam' });

    // Exactly what a Steam sync writes: the counts through `updateGame`, the
    // rows through `replaceGameTrophies`, both from one fetched payload.
    const rows = psnList(63, 30).map((t) => ({ ...t, source: 'steam' as const, tier: null, groupId: null }));
    await trophies.replaceGameTrophies(owner, game.id, 'steam', rows);
    await games.updateGame(owner, game.id, {
      title: 'Hollow Knight',
      platform: 'steam',
      achievementsUnlocked: rows.filter((r) => r.earned).length,
      achievementsTotal: rows.length,
    });

    const stored = await games.getGame(owner, game.id);
    const trophyRows = await trophies.listGameTrophies(owner, game.id);

    expect(stored.achievementsTotal).toBe(trophyRows.length);
    expect(stored.achievementsUnlocked).toBe(trophyRows.filter((t) => t.earned).length);
  });
});
