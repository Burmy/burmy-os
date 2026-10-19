import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { harness, provisionOwner, resetDatabase } from './harness';

/**
 * The games Server Action path (`src/features/games/game-actions.ts`) end to
 * end, against a real Postgres — not just the DAL functions it calls (that is
 * `tests/integration/games.test.ts`'s job).
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
 * meaningful behavior to assert outside a real server anyway.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const requestHeaders = { current: new Headers() };

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(requestHeaders.current),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

type GameActions = typeof import('@/features/games/game-actions');
type Games = typeof import('@/server/db/games/games');

let actions: GameActions;
let games: Games;

beforeAll(async () => {
  await harness();
  [actions, games] = await Promise.all([
    import('@/features/games/game-actions'),
    import('@/server/db/games/games'),
  ]);
});

beforeEach(async () => {
  await resetDatabase();
  requestHeaders.current = new Headers();
});

/** Minimum viable FormData for the dialog's create/update submit — title and platform are the only required fields. */
function baseFormData(overrides: Record<string, string> = {}): FormData {
  const formData = new FormData();
  formData.set('title', 'Ratchet & Clank: Rift Apart');
  formData.set('platform', 'ps5');
  formData.set('status', 'played');
  for (const [key, value] of Object.entries(overrides)) formData.set(key, value);
  return formData;
}

describe('createGameAction — platinum', () => {
  it('defaults to false when the checkbox is not in FormData at all', async () => {
    const ownerId = await provisionOwner();

    const result = await actions.createGameAction(baseFormData());

    expect(result.ok).toBe(true);
    const [created] = await games.listGames(ownerId);
    expect(created?.platinum).toBe(false);
  });

  it('sets true when the checkbox is checked', async () => {
    const ownerId = await provisionOwner();

    const result = await actions.createGameAction(baseFormData({ platinum: 'true' }));

    expect(result.ok).toBe(true);
    const [created] = await games.listGames(ownerId);
    expect(created?.platinum).toBe(true);
  });
});

describe('createGameAction — play-year split', () => {
  it('persists a split that sums to the total and reads it back through both listGames and getGame', async () => {
    const ownerId = await provisionOwner();

    const result = await actions.createGameAction(
      baseFormData({
        hours: '49',
        playYears: JSON.stringify([
          { year: '2024', hours: '37' },
          { year: '2025', hours: '12' },
        ]),
      }),
    );

    expect(result.ok).toBe(true);

    const [listed] = await games.listGames(ownerId);
    expect(listed?.playYears).toEqual([
      { year: 2024, hoursTenths: 370 },
      { year: 2025, hoursTenths: 120 },
    ]);

    const fetched = await games.getGame(ownerId, listed!.id);
    expect(fetched.playYears).toEqual([
      { year: 2024, hoursTenths: 370 },
      { year: 2025, hoursTenths: 120 },
    ]);
  });
});

describe('game actions — play-year split validation', () => {
  it('rejects a split that does not sum to the total and writes nothing at all', async () => {
    const ownerId = await provisionOwner();

    const result = await actions.createGameAction(
      baseFormData({
        hours: '49',
        playYears: JSON.stringify([
          { year: '2024', hours: '30' },
          { year: '2025', hours: '12' },
        ]),
      }),
    );

    expect(result.ok).toBe(false);
    expect(await games.listGames(ownerId)).toEqual([]);
  });

  /**
   * Regression test for the CRITICAL finding in the Task 4 review:
   * `validateSplit` only checks the SUM, never year uniqueness, so a split
   * like 2024/20 + 2024/17 + 2025/12 (sum = 49, matching the total) used to
   * sail past validation and only fail once `replacePlayYears` hit
   * `game_play_years_game_year_idx` — a throw that `toResult()` could not
   * route (not a `DuplicateGameError`/`GameNotFoundError`/`z.ZodError`) and
   * that nothing caught, surfacing as an unhandled fault instead of a field
   * error. Before `findDuplicateYear` + the early rejection in
   * `game-actions.ts`, `await actions.createGameAction(...)` below would
   * REJECT rather than resolve to `{ ok: false }`, failing this test at the
   * very first assertion.
   */
  it('rejects duplicate years in a split and writes nothing, rather than crashing on the unique index', async () => {
    const ownerId = await provisionOwner();

    const result = await actions.createGameAction(
      baseFormData({
        hours: '49',
        playYears: JSON.stringify([
          { year: '2024', hours: '20' },
          { year: '2024', hours: '17' },
          { year: '2025', hours: '12' },
        ]),
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('2024');
    // No orphan game row left behind despite the split failing.
    expect(await games.listGames(ownerId)).toEqual([]);
  });
});

describe('updateGameFieldAction — releaseDate', () => {
  it('stores a hand-entered date at day precision, and clears both columns on an empty commit', async () => {
    const ownerId = await provisionOwner();
    const created = await games.createGame(ownerId, {
      title: 'Hollow Knight: Silksong',
      platform: 'steam',
      status: 'wanted',
    });

    expect((await actions.updateGameFieldAction(created.id, 'releaseDate', '2026-11-20')).ok).toBe(
      true,
    );
    let fetched = await games.getGame(ownerId, created.id);
    expect(fetched.releaseDate).toBe('2026-11-20');
    expect(fetched.releasePrecision).toBe('day');

    expect((await actions.updateGameFieldAction(created.id, 'releaseDate', '')).ok).toBe(true);
    fetched = await games.getGame(ownerId, created.id);
    expect(fetched.releaseDate).toBeNull();
    expect(fetched.releasePrecision).toBeNull();
  });

  it('rejects a date that is not a real calendar day, leaving the row untouched', async () => {
    const ownerId = await provisionOwner();
    const created = await games.createGame(ownerId, {
      title: 'Silksong',
      platform: 'steam',
      status: 'wanted',
    });

    for (const bad of ['2026-02-30', '2026-13-01', 'next year', '20261120']) {
      const result = await actions.updateGameFieldAction(created.id, 'releaseDate', bad);
      expect(result.ok, bad).toBe(false);
    }
    expect((await games.getGame(ownerId, created.id)).releaseDate).toBeNull();
  });
});

describe('completeWishlistGameAction', () => {
  it('refuses a game that is not wanted', async () => {
    const ownerId = await provisionOwner();
    const game = await games.createGame(ownerId, { title: 'Elden Ring', platform: 'ps5' });

    const result = await actions.completeWishlistGameAction(game.id, baseFormData({ hours: '10' }));

    expect(result.ok).toBe(false);
    expect((await games.getGame(ownerId, game.id)).hoursTenths).toBeNull();
  });

  it('moves a wanted game into the library with the figures from the form and a replaced split', async () => {
    const ownerId = await provisionOwner();
    const game = await games.createGame(ownerId, {
      title: 'Marvel’s Wolverine',
      platform: 'ps5',
      status: 'wanted',
      releaseDate: '2026-10-01',
      releasePrecision: 'day',
    });

    const result = await actions.completeWishlistGameAction(
      game.id,
      baseFormData({
        title: 'Marvel’s Wolverine',
        hours: '16',
        priceDollars: '69.99',
        firstPlayedYear: '2026',
        rating: '4',
        ownership: 'digital',
        // The form has no status control in complete mode; a stray value must not win.
        status: 'wanted',
        playYears: JSON.stringify([{ year: '2026', hours: '16' }]),
      }),
    );

    expect(result).toEqual({ ok: true });
    const saved = await games.getGame(ownerId, game.id);
    expect(saved).toMatchObject({
      status: 'played',
      hoursTenths: 160,
      priceCents: 6999,
      firstPlayedYear: 2026,
      rating: 4,
      ownership: 'digital',
    });
    expect(saved.playYears).toEqual([{ year: 2026, hoursTenths: 160 }]);
  });
});

describe('collection actions — a game that has DLC', () => {
  it('files it like any other game; the DLC stays with it (2026-10-19 — a member’s hours are its own)', async () => {
    const ownerId = await provisionOwner();
    const dlc = await import('@/server/db/games/dlc');
    const set = await games.createGame(ownerId, {
      title: 'Nathan Drake Collection',
      platform: 'ps4',
    });
    const game = await games.createGame(ownerId, { title: "Drake's Fortune", platform: 'ps4' });
    await dlc.createDlc(ownerId, game.id, { name: 'DLC', year: 2021 });

    const viaField = await actions.updateGameCollectionAction(game.id, set.id);
    expect(viaField.ok).toBe(true);

    const filed = await games.getGame(ownerId, game.id);
    expect(filed.collectionId).toBe(set.id);
    expect(filed.dlc.map((row) => row.name)).toEqual(['DLC']);
  });
});

describe('updateGameFieldAction — platinum', () => {
  it('earning the platinum fills trophies earned up to the total (owner, 2026-10-19)', async () => {
    const ownerId = await provisionOwner();
    const created = await games.createGame(ownerId, {
      title: 'Ghost of Tsushima',
      platform: 'ps4',
      achievementsUnlocked: 40,
      achievementsTotal: 69,
    });

    expect((await actions.updateGameFieldAction(created.id, 'platinum', 'true')).ok).toBe(true);

    const fetched = await games.getGame(ownerId, created.id);
    expect(fetched.platinum).toBe(true);
    expect(fetched.achievementsUnlocked).toBe(69);
  });

  it('leaves trophies earned alone when no total is known, and when the platinum is taken back', async () => {
    const ownerId = await provisionOwner();
    const created = await games.createGame(ownerId, {
      title: 'Bloodborne',
      platform: 'ps4',
      achievementsUnlocked: 30,
      achievementsTotal: null,
    });

    expect((await actions.updateGameFieldAction(created.id, 'platinum', 'true')).ok).toBe(true);
    expect((await games.getGame(ownerId, created.id)).achievementsUnlocked).toBe(30);

    expect((await actions.updateGameFieldAction(created.id, 'platinum', '')).ok).toBe(true);
    const fetched = await games.getGame(ownerId, created.id);
    expect(fetched.platinum).toBe(false);
    expect(fetched.achievementsUnlocked).toBe(30);
  });
});

describe('updateGameFieldAction — rating on a collection', () => {
  it('refuses as a readable failure: a collection has no rating of its own (2026-10-19)', async () => {
    const ownerId = await provisionOwner();
    const set = await games.createGame(ownerId, {
      title: 'Nathan Drake Collection',
      platform: 'ps4',
    });
    const member = await games.createGame(ownerId, { title: "Drake's Fortune", platform: 'ps4' });
    await games.setGameCollection(ownerId, member.id, set.id);

    const result = await actions.updateGameFieldAction(set.id, 'rating', '4');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/collection/i);
    expect((await games.getGame(ownerId, set.id)).rating).toBeNull();
    // The game inside it rates normally.
    expect((await actions.updateGameFieldAction(member.id, 'rating', '4')).ok).toBe(true);
  });
});
