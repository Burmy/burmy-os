import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { harness, provisionOwner, resetDatabase } from './harness';

/**
 * The DLC Server Actions (`src/features/games/dlc-actions.ts`) end to end,
 * against a real Postgres. `next/headers` and `next/cache` are mocked for the
 * same reasons `games-actions.test.ts` spells out.
 *
 * `tests/integration/entry-points.test.ts` walks `src/app` only, so feature
 * action files are not enumerated there — the first test here is the
 * owner-boundary check for this file.
 */

const requestHeaders = { current: new Headers() };

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(requestHeaders.current),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

type DlcActions = typeof import('@/features/games/dlc-actions');
type Games = typeof import('@/server/db/games/games');
type Dlc = typeof import('@/server/db/games/dlc');

let actions: DlcActions;
let games: Games;
let dlc: Dlc;

beforeAll(async () => {
  await harness();
  [actions, games, dlc] = await Promise.all([
    import('@/features/games/dlc-actions'),
    import('@/server/db/games/games'),
    import('@/server/db/games/dlc'),
  ]);
});

beforeEach(async () => {
  await resetDatabase();
  requestHeaders.current = new Headers();
});

function form(fields: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) formData.set(key, value);
  return formData;
}

async function playedGame(ownerId: string, title = 'Elden Ring'): Promise<string> {
  const game = await games.createGame(ownerId, { title, platform: 'ps5' });
  return game.id;
}

describe('owner boundary', () => {
  it('every action refuses when there is no owner on the request', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    await expect(
      actions.createGameDlcAction(id, form({ name: 'DLC', year: '2025' })),
    ).rejects.toThrow();
    await expect(
      actions.updateGameDlcAction(id, form({ name: 'x', year: '2025' })),
    ).rejects.toThrow();
    await expect(actions.deleteGameDlcAction(id)).rejects.toThrow();
  });
});

describe('createGameDlcAction', () => {
  it('creates a row with every figure parsed into storage units', async () => {
    const ownerId = await provisionOwner();
    const gameId = await playedGame(ownerId);

    const result = await actions.createGameDlcAction(
      gameId,
      form({
        name: 'Shadow of the Erdtree',
        year: '2025',
        hours: '6',
        priceDollars: '39.99',
        achievementsUnlocked: '10',
        achievementsTotal: '12',
      }),
    );

    expect(result).toEqual({ ok: true });
    const [row] = await dlc.listDlcForGame(ownerId, gameId);
    expect(row).toMatchObject({
      name: 'Shadow of the Erdtree',
      year: 2025,
      hoursTenths: 60,
      priceCents: 3999,
      achievementsUnlocked: 10,
      achievementsTotal: 12,
    });
  });

  it('needs only a name and a year', async () => {
    const ownerId = await provisionOwner();
    const gameId = await playedGame(ownerId);

    expect(await actions.createGameDlcAction(gameId, form({ name: 'DLC', year: '2026' }))).toEqual({
      ok: true,
    });
    expect((await dlc.listDlcForGame(ownerId, gameId))[0]?.hoursTenths).toBeNull();
  });

  it('rejects a blank name as a field error', async () => {
    const ownerId = await provisionOwner();
    const gameId = await playedGame(ownerId);

    const result = await actions.createGameDlcAction(gameId, form({ name: '   ', year: '2025' }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('name');
    expect(await dlc.listDlcForGame(ownerId, gameId)).toEqual([]);
  });

  it('rejects a year before 1970', async () => {
    const ownerId = await provisionOwner();
    const gameId = await playedGame(ownerId);

    const result = await actions.createGameDlcAction(gameId, form({ name: 'DLC', year: '1969' }));

    expect(result.ok).toBe(false);
  });

  it('rejects unparseable hours with the same message the game form uses', async () => {
    const ownerId = await provisionOwner();
    const gameId = await playedGame(ownerId);

    const result = await actions.createGameDlcAction(
      gameId,
      form({ name: 'DLC', year: '2025', hours: 'six' }),
    );

    expect(result).toMatchObject({ ok: false, field: 'hours' });
  });

  it('surfaces the collection-member refusal as a readable error, not a 500', async () => {
    const ownerId = await provisionOwner();
    const setId = await playedGame(ownerId, 'Nathan Drake Collection');
    const memberId = await playedGame(ownerId, "Drake's Fortune");
    await games.setGameCollection(ownerId, memberId, setId);

    const result = await actions.createGameDlcAction(memberId, form({ name: 'DLC', year: '2025' }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/collection/i);
  });

  it('surfaces a duplicate name as a field error on name', async () => {
    const ownerId = await provisionOwner();
    const gameId = await playedGame(ownerId);
    await actions.createGameDlcAction(gameId, form({ name: 'DLC', year: '2025' }));

    const result = await actions.createGameDlcAction(gameId, form({ name: 'dlc', year: '2026' }));

    expect(result).toMatchObject({ ok: false, field: 'name' });
  });
});

describe('updateGameDlcAction', () => {
  async function seeded(): Promise<{ ownerId: string; gameId: string; dlcId: string }> {
    const ownerId = await provisionOwner();
    const gameId = await playedGame(ownerId);
    const row = await dlc.createDlc(ownerId, gameId, {
      name: 'DLC',
      year: 2025,
      hoursTenths: 60,
      priceCents: 1999,
    });
    return { ownerId, gameId, dlcId: row.id };
  }

  it('replaces the whole row from the form: a figure left blank is cleared', async () => {
    const { ownerId, gameId, dlcId } = await seeded();

    const result = await actions.updateGameDlcAction(
      dlcId,
      form({ name: 'Shadow of the Erdtree', year: '2026', hours: '2.5' }),
    );

    expect(result).toEqual({ ok: true });
    const [row] = await dlc.listDlcForGame(ownerId, gameId);
    expect(row).toMatchObject({
      name: 'Shadow of the Erdtree',
      year: 2026,
      hoursTenths: 25,
      priceCents: null,
      achievementsUnlocked: null,
      achievementsTotal: null,
    });
  });

  it('stores dollars as cents and both trophy counts', async () => {
    const { ownerId, gameId, dlcId } = await seeded();
    await actions.updateGameDlcAction(
      dlcId,
      form({
        name: 'DLC',
        year: '2025',
        priceDollars: '19.99',
        achievementsUnlocked: '10',
        achievementsTotal: '12',
      }),
    );
    const [row] = await dlc.listDlcForGame(ownerId, gameId);
    expect(row?.priceCents).toBe(1999);
    expect(row?.achievementsUnlocked).toBe(10);
    expect(row?.achievementsTotal).toBe(12);
  });

  it('refuses a blank name or year as a field error', async () => {
    const { dlcId } = await seeded();
    expect(
      await actions.updateGameDlcAction(dlcId, form({ name: '', year: '2025' })),
    ).toMatchObject({
      ok: false,
      field: 'name',
    });
    expect(await actions.updateGameDlcAction(dlcId, form({ name: 'DLC', year: '' }))).toMatchObject(
      {
        ok: false,
        field: 'year',
      },
    );
  });

  it('is a not-found for a row that belongs to someone else', async () => {
    await provisionOwner();
    const otherId = await provisionOwner('other@burmy.test');
    const otherGame = await games.createGame(otherId, { title: 'Elden Ring', platform: 'ps5' });
    const row = await dlc.createDlc(otherId, otherGame.id, { name: 'DLC', year: 2025 });

    const result = await actions.updateGameDlcAction(row.id, form({ name: 'DLC', year: '2026' }));

    expect(result.ok).toBe(false);
    expect((await dlc.listDlcForGame(otherId, otherGame.id))[0]?.year).toBe(2025);
  });
});

describe('deleteGameDlcAction', () => {
  it('removes the row', async () => {
    const ownerId = await provisionOwner();
    const gameId = await playedGame(ownerId);
    const row = await dlc.createDlc(ownerId, gameId, { name: 'DLC', year: 2025 });

    expect(await actions.deleteGameDlcAction(row.id)).toEqual({ ok: true });
    expect(await dlc.listDlcForGame(ownerId, gameId)).toEqual([]);
  });

  it('rejects a malformed id as a failure result', async () => {
    await provisionOwner();
    expect((await actions.deleteGameDlcAction('not-a-uuid')).ok).toBe(false);
  });
});
