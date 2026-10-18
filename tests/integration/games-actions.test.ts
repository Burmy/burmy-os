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
