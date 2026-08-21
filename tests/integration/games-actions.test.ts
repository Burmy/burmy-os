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
