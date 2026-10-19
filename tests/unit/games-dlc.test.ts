import { describe, expect, it } from 'vitest';

import { type GameDlcRow, gameTotals, groupDlcByGame, sumDlc } from '@/server/games/dlc';

function dlc(overrides: Partial<GameDlcRow> = {}): GameDlcRow {
  return {
    id: 'dlc-1',
    gameId: 'game-1',
    name: 'Shadow of the Erdtree',
    year: 2025,
    hoursTenths: 60,
    priceCents: 3999,
    achievementsUnlocked: 10,
    achievementsTotal: 12,
    ...overrides,
  };
}

/**
 * DLC is ADDITIVE, never attributed: a row's hours, price and trophies add
 * on top of the game's own base figures, and nothing has to "add up" to
 * anything. The null handling is the whole point — a missing figure stays
 * missing, it never becomes a zero that then reads as "tracked, and zero".
 */
describe('sumDlc', () => {
  it('returns null for every field when there are no rows', () => {
    expect(sumDlc([])).toEqual({
      hoursTenths: null,
      priceCents: null,
      achievementsUnlocked: null,
      achievementsTotal: null,
    });
  });

  it('adds every field across rows, treating a null on one row as nothing rather than zero', () => {
    const sums = sumDlc([
      dlc({
        id: 'a',
        hoursTenths: 60,
        priceCents: 3999,
        achievementsUnlocked: 10,
        achievementsTotal: 12,
      }),
      dlc({
        id: 'b',
        hoursTenths: null,
        priceCents: 1499,
        achievementsUnlocked: null,
        achievementsTotal: null,
      }),
    ]);
    expect(sums).toEqual({
      hoursTenths: 60,
      priceCents: 5498,
      achievementsUnlocked: 10,
      achievementsTotal: 12,
    });
  });

  it('returns null, not 0, for a field no row carries', () => {
    expect(
      sumDlc([dlc({ priceCents: null }), dlc({ id: 'b', priceCents: null })]).priceCents,
    ).toBeNull();
  });
});

describe('gameTotals', () => {
  const base = {
    hoursTenths: 530,
    priceCents: 5999,
    achievementsUnlocked: 42,
    achievementsTotal: 54,
  };

  it('adds the DLC sums onto the base figures', () => {
    expect(gameTotals(base, [dlc()])).toEqual({
      hoursTenths: 590,
      priceCents: 9998,
      achievementsUnlocked: 52,
      achievementsTotal: 66,
    });
  });

  it('sums a DLC onto a null base — the total is the DLC figure, not null and not NaN', () => {
    const totals = gameTotals({ ...base, hoursTenths: null }, [dlc({ hoursTenths: 60 })]);
    expect(totals.hoursTenths).toBe(60);
  });

  it('returns null when neither side has a value', () => {
    const totals = gameTotals({ ...base, priceCents: null }, [dlc({ priceCents: null })]);
    expect(totals.priceCents).toBeNull();
  });

  it('is the base figures exactly when there is no DLC', () => {
    expect(gameTotals(base, [])).toEqual(base);
  });

  it('never returns negative zero', () => {
    const totals = gameTotals({ ...base, hoursTenths: 0 }, []);
    expect(Object.is(totals.hoursTenths, 0)).toBe(true);
    expect(Object.is(totals.hoursTenths, -0)).toBe(false);
  });
});

describe('groupDlcByGame', () => {
  it('groups rows by game id, in the order given, and ignores nothing', () => {
    const grouped = groupDlcByGame([
      dlc({ id: 'a', gameId: 'g1' }),
      dlc({ id: 'b', gameId: 'g2' }),
      dlc({ id: 'c', gameId: 'g1' }),
    ]);
    expect(grouped.get('g1')?.map((row) => row.id)).toEqual(['a', 'c']);
    expect(grouped.get('g2')?.map((row) => row.id)).toEqual(['b']);
    expect(grouped.get('g3')).toBeUndefined();
  });
});
