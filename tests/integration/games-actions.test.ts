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
type PlayYearsDb = typeof import('@/server/db/games/play-years');

let actions: GameActions;
let games: Games;
let playYearsDb: PlayYearsDb;

beforeAll(async () => {
  await harness();
  [actions, games, playYearsDb] = await Promise.all([
    import('@/features/games/game-actions'),
    import('@/server/db/games/games'),
    import('@/server/db/games/play-years'),
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
  formData.set('status', 'completed');
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

describe('updateGameAction — platinum can be turned back OFF', () => {
  it('flips an existing platinum back to false when the box is unchecked on save', async () => {
    const ownerId = await provisionOwner();
    const created = await games.createGame(ownerId, {
      title: 'Ratchet & Clank: Rift Apart',
      platform: 'ps5',
      platinum: true,
    });
    expect(created.platinum).toBe(true);

    // The real dialog submits every field it renders on every save — an
    // unchecked box simply has no "platinum" entry in the resulting FormData,
    // the same shape a real uncheck-then-save produces.
    const uncheckedFormData = baseFormData();
    expect(uncheckedFormData.has('platinum')).toBe(false);

    const result = await actions.updateGameAction(created.id, uncheckedFormData);

    expect(result.ok).toBe(true);
    const updated = await games.getGame(ownerId, created.id);
    expect(updated.platinum).toBe(false);
  });

  it('keeps platinum true across an update that re-checks it', async () => {
    const ownerId = await provisionOwner();
    const created = await games.createGame(ownerId, {
      title: 'Returnal',
      platform: 'ps5',
      platinum: false,
    });

    const result = await actions.updateGameAction(created.id, baseFormData({ platinum: 'true' }));

    expect(result.ok).toBe(true);
    const updated = await games.getGame(ownerId, created.id);
    expect(updated.platinum).toBe(true);
  });

  it('leaves an untouched platinum alone when the form resubmits it checked', async () => {
    const ownerId = await provisionOwner();
    const created = await games.createGame(ownerId, {
      title: 'Astro Bot',
      platform: 'ps5',
      platinum: true,
    });

    const result = await actions.updateGameAction(created.id, baseFormData({ platinum: 'true', title: 'Astro Bot' }));

    expect(result.ok).toBe(true);
    const updated = await games.getGame(ownerId, created.id);
    expect(updated.platinum).toBe(true);
  });
});

/**
 * The play-year split, end to end through the Server Action path — not just
 * `replacePlayYears` itself (that is `tests/integration/games-play-years.test.ts`'s
 * job) but the whole `parse() -> validate -> write game -> write split` chain
 * in `game-actions.ts`.
 */
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

describe('updateGameAction — play-year split', () => {
  it('replaces the previous split rather than appending to it', async () => {
    const ownerId = await provisionOwner();
    const created = await games.createGame(ownerId, {
      title: 'Ratchet & Clank: Rift Apart',
      platform: 'ps5',
      hoursTenths: 490,
    });
    await playYearsDb.replacePlayYears(ownerId, created.id, [{ year: 2022, hoursTenths: 490 }]);

    const result = await actions.updateGameAction(
      created.id,
      baseFormData({
        hours: '49',
        playYears: JSON.stringify([
          { year: '2024', hours: '37' },
          { year: '2025', hours: '12' },
        ]),
      }),
    );

    expect(result.ok).toBe(true);
    const updated = await games.getGame(ownerId, created.id);
    expect(updated.playYears).toEqual([
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

  /**
   * The other half of the same regression: on UPDATE, `updateGame()` commits
   * the game's new field values BEFORE `replacePlayYears` runs, so an
   * unhandled crash there used to leave the game row with its NEW values
   * while `game_play_years` kept the OLD split — real inconsistent state.
   * With the duplicate check running before either write, neither the game
   * row nor the split should change at all.
   */
  it('rejects duplicate years on update without changing the game row or the existing split', async () => {
    const ownerId = await provisionOwner();
    const created = await games.createGame(ownerId, {
      title: 'Ratchet & Clank: Rift Apart',
      platform: 'ps5',
      hoursTenths: 490,
      rating: 3,
    });
    await playYearsDb.replacePlayYears(ownerId, created.id, [{ year: 2022, hoursTenths: 490 }]);

    const result = await actions.updateGameAction(
      created.id,
      baseFormData({
        hours: '49',
        rating: '5',
        playYears: JSON.stringify([
          { year: '2024', hours: '20' },
          { year: '2024', hours: '17' },
          { year: '2025', hours: '12' },
        ]),
      }),
    );

    expect(result.ok).toBe(false);
    const unchanged = await games.getGame(ownerId, created.id);
    expect(unchanged.rating).toBe(3);
    expect(unchanged.playYears).toEqual([{ year: 2022, hoursTenths: 490 }]);
  });
});

/**
 * Task 5: for a game linked to a Steam app, Steam owns its hours and
 * achievement counts — game-dialog.tsx renders those fields disabled, but a
 * disabled input is a UI affordance, not a security boundary (devtools can
 * re-enable it), so `updateGameAction` must independently ignore whatever
 * the form actually submitted for them. This is the server-side half of the
 * fix; `tests/unit/games-game-dialog.test.tsx`'s "GameDialog Steam
 * provenance" suite covers the UI half.
 */
describe('updateGameAction — Steam-owned fields', () => {
  it('ignores a submitted hours value for a Steam-linked game', async () => {
    const ownerId = await provisionOwner();
    const created = await games.createGame(ownerId, {
      title: 'Hades',
      platform: 'steam',
      steamAppid: 367520,
      hoursTenths: 500,
    });

    const result = await actions.updateGameAction(created.id, baseFormData({ hours: '999' }));

    expect(result.ok).toBe(true);
    const updated = await games.getGame(ownerId, created.id);
    expect(updated.hoursTenths).toBe(500);
  });

  it('ignores submitted achievement values for a Steam-linked game', async () => {
    const ownerId = await provisionOwner();
    const created = await games.createGame(ownerId, {
      title: 'Hades',
      platform: 'steam',
      steamAppid: 367520,
      achievementsUnlocked: 10,
      achievementsTotal: 33,
    });

    const result = await actions.updateGameAction(
      created.id,
      baseFormData({ achievementsUnlocked: '99', achievementsTotal: '100' }),
    );

    expect(result.ok).toBe(true);
    const updated = await games.getGame(ownerId, created.id);
    expect(updated.achievementsUnlocked).toBe(10);
    expect(updated.achievementsTotal).toBe(33);
  });

  it('still accepts a submitted hours value for a game with no Steam link', async () => {
    // Proves the stripping is conditional on `steamAppid`, not a blanket
    // rule that would make Hours uneditable for every game.
    const ownerId = await provisionOwner();
    const created = await games.createGame(ownerId, {
      title: 'Ratchet & Clank: Rift Apart',
      platform: 'ps5',
      hoursTenths: 100,
    });

    const result = await actions.updateGameAction(created.id, baseFormData({ hours: '25' }));

    expect(result.ok).toBe(true);
    const updated = await games.getGame(ownerId, created.id);
    expect(updated.hoursTenths).toBe(250);
  });

  it('keeps a Steam-linked game with a play-year split saveable — the split still validates against the existing (unstripped) total', async () => {
    // Regression guard for the companion fix this task required: if the
    // split's total were taken from the (now-stripped) submitted `hours`
    // field instead of the game's own current total, this save would fail
    // validation on every edit of a Steam-linked game that has a split.
    const ownerId = await provisionOwner();
    const created = await games.createGame(ownerId, {
      title: 'Hades',
      platform: 'steam',
      steamAppid: 367520,
      hoursTenths: 490,
    });
    await playYearsDb.replacePlayYears(ownerId, created.id, [{ year: 2024, hoursTenths: 490 }]);

    const result = await actions.updateGameAction(
      created.id,
      baseFormData({
        rating: '4',
        playYears: JSON.stringify([{ year: '2024', hours: '49' }]),
      }),
    );

    expect(result.ok).toBe(true);
    const updated = await games.getGame(ownerId, created.id);
    expect(updated.hoursTenths).toBe(490);
    expect(updated.playYears).toEqual([{ year: 2024, hoursTenths: 490 }]);
  });
});
