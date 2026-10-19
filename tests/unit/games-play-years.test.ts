import { describe, expect, it } from 'vitest';

import {
  type AttributableGame,
  type PlayYearRow,
  attributeHours,
  findDuplicateYear,
  validateSplit,
  validateTrophySplit,
} from '@/server/games/play-years';

function game(overrides: Partial<AttributableGame> = {}): AttributableGame {
  return {
    id: 'game-1',
    firstPlayedYear: 2024,
    hoursTenths: 490,
    achievementsUnlocked: null,
    ...overrides,
  };
}

describe('attributeHours', () => {
  it('attributes all hours to firstPlayedYear when a game has no split rows', () => {
    const result = attributeHours(
      [game({ id: 'g1', firstPlayedYear: 2024, hoursTenths: 490 })],
      [],
    );

    expect(result.attributions).toEqual([
      { year: 2024, gameId: 'g1', hoursTenths: 490, achievementsUnlocked: 0 },
    ]);
    expect(result.unattributedTenths).toBe(0);
  });

  it('uses the split rows instead of firstPlayedYear when they exist', () => {
    const rows: PlayYearRow[] = [
      { gameId: 'g1', year: 2024, hoursTenths: 370, achievementsUnlocked: null },
      { gameId: 'g1', year: 2025, hoursTenths: 120, achievementsUnlocked: null },
    ];

    const result = attributeHours(
      [game({ id: 'g1', firstPlayedYear: 2024, hoursTenths: 490 })],
      rows,
    );

    expect(result.attributions).toEqual([
      { year: 2024, gameId: 'g1', hoursTenths: 370, achievementsUnlocked: 0 },
      { year: 2025, gameId: 'g1', hoursTenths: 120, achievementsUnlocked: 0 },
    ]);
    expect(result.unattributedTenths).toBe(0);
  });

  it('excludes a game with no year and no split rows rather than bucketing it at year zero', () => {
    const result = attributeHours([game({ id: 'g1', firstPlayedYear: null })], []);

    expect(result.attributions).toEqual([]);
  });

  it('still attributes a game with no firstPlayedYear when it has explicit split rows', () => {
    const rows: PlayYearRow[] = [
      { gameId: 'g1', year: 2019, hoursTenths: 80, achievementsUnlocked: null },
    ];

    const result = attributeHours(
      [game({ id: 'g1', firstPlayedYear: null, hoursTenths: 80 })],
      rows,
    );

    expect(result.attributions).toEqual([
      { year: 2019, gameId: 'g1', hoursTenths: 80, achievementsUnlocked: 0 },
    ]);
  });

  it('treats a null total as zero hours', () => {
    const result = attributeHours(
      [game({ id: 'g1', firstPlayedYear: 2020, hoursTenths: null })],
      [],
    );

    expect(result.attributions).toEqual([
      { year: 2020, gameId: 'g1', hoursTenths: 0, achievementsUnlocked: 0 },
    ]);
  });

  it('reports the remainder when a split does not account for the whole total', () => {
    // Steam moved the total to 51.0h; the owner's split still says 37 + 12 = 49.0h.
    const rows: PlayYearRow[] = [
      { gameId: 'g1', year: 2024, hoursTenths: 370, achievementsUnlocked: null },
      { gameId: 'g1', year: 2025, hoursTenths: 120, achievementsUnlocked: null },
    ];

    const result = attributeHours([game({ id: 'g1', hoursTenths: 510 })], rows);

    expect(result.unattributedTenths).toBe(20);
  });

  it('reports a NEGATIVE remainder when a split over-accounts for the total', () => {
    const rows: PlayYearRow[] = [
      { gameId: 'g1', year: 2024, hoursTenths: 600, achievementsUnlocked: null },
    ];

    const result = attributeHours([game({ id: 'g1', hoursTenths: 490 })], rows);

    expect(result.unattributedTenths).toBe(-110);
  });

  it('ignores split rows belonging to a game not in the list', () => {
    const rows: PlayYearRow[] = [
      { gameId: 'ghost', year: 2024, hoursTenths: 999, achievementsUnlocked: null },
    ];

    const result = attributeHours(
      [game({ id: 'g1', firstPlayedYear: 2024, hoursTenths: 490 })],
      rows,
    );

    expect(result.attributions).toEqual([
      { year: 2024, gameId: 'g1', hoursTenths: 490, achievementsUnlocked: 0 },
    ]);
    expect(result.unattributedTenths).toBe(0);
  });

  it('sums remainders across several games', () => {
    const games = [game({ id: 'g1', hoursTenths: 510 }), game({ id: 'g2', hoursTenths: 200 })];
    const rows: PlayYearRow[] = [
      { gameId: 'g1', year: 2024, hoursTenths: 490, achievementsUnlocked: null },
      { gameId: 'g2', year: 2024, hoursTenths: 150, achievementsUnlocked: null },
    ];

    expect(attributeHours(games, rows).unattributedTenths).toBe(70);
  });
});

describe('validateSplit', () => {
  it('accepts a split that sums exactly to the total', () => {
    expect(validateSplit(490, [{ hoursTenths: 370 }, { hoursTenths: 120 }])).toEqual({
      ok: true,
      splitTenths: 490,
      totalTenths: 490,
      differenceTenths: 0,
    });
  });

  it('rejects a split that falls short and reports the shortfall', () => {
    expect(validateSplit(510, [{ hoursTenths: 370 }, { hoursTenths: 120 }])).toEqual({
      ok: false,
      splitTenths: 490,
      totalTenths: 510,
      differenceTenths: 20,
    });
  });

  it('rejects a split that overshoots and reports a negative difference', () => {
    expect(validateSplit(490, [{ hoursTenths: 600 }])).toEqual({
      ok: false,
      splitTenths: 600,
      totalTenths: 490,
      differenceTenths: -110,
    });
  });

  it('treats an empty split as valid — no split means no constraint', () => {
    expect(validateSplit(490, []).ok).toBe(true);
  });
});

describe('findDuplicateYear', () => {
  it('returns null when every year is unique', () => {
    expect(findDuplicateYear([{ year: 2024 }, { year: 2025 }])).toBeNull();
  });

  it('returns the repeated year', () => {
    expect(findDuplicateYear([{ year: 2024 }, { year: 2025 }, { year: 2024 }])).toBe(2024);
  });

  it('returns null for an empty split', () => {
    expect(findDuplicateYear([])).toBeNull();
  });

  it('returns null for a single row', () => {
    expect(findDuplicateYear([{ year: 2024 }])).toBeNull();
  });

  it('finds the repeat regardless of how many other unique years surround it', () => {
    expect(
      findDuplicateYear([
        { year: 2019 },
        { year: 2020 },
        { year: 2021 },
        { year: 2020 },
        { year: 2022 },
      ]),
    ).toBe(2020);
  });
});

/**
 * Trophies per year (2026-10-19): the sheet's "33 + 13" meant 33 earned in
 * 2024 and 13 in 2025. A split's rows may carry a trophies figure; once any
 * does, the rows own the trophies (a blank counting 0); while none does,
 * every trophy stays on the first-played year, as before the column existed.
 */
describe('attributeHours — trophies', () => {
  const g = game({ id: 'hk', firstPlayedYear: 2024, hoursTenths: 490, achievementsUnlocked: 46 });

  it('credits all trophies to firstPlayedYear when a game has no split rows', () => {
    const { attributions } = attributeHours([g], []);
    expect(attributions).toEqual([
      { year: 2024, gameId: 'hk', hoursTenths: 490, achievementsUnlocked: 46 },
    ]);
  });

  it('credits each row its own trophies when the rows say', () => {
    const { attributions } = attributeHours(
      [g],
      [
        { gameId: 'hk', year: 2024, hoursTenths: 370, achievementsUnlocked: 33 },
        { gameId: 'hk', year: 2025, hoursTenths: 120, achievementsUnlocked: 13 },
      ],
    );
    expect(attributions.map((a) => [a.year, a.achievementsUnlocked])).toEqual([
      [2024, 33],
      [2025, 13],
    ]);
  });

  it('counts a blank row as 0 once any row carries a figure', () => {
    const { attributions } = attributeHours(
      [g],
      [
        { gameId: 'hk', year: 2024, hoursTenths: 370, achievementsUnlocked: 46 },
        { gameId: 'hk', year: 2025, hoursTenths: 120, achievementsUnlocked: null },
      ],
    );
    expect(attributions.map((a) => a.achievementsUnlocked)).toEqual([46, 0]);
  });

  it('leaves every trophy on the first-played year when no row says anything about trophies', () => {
    const { attributions } = attributeHours(
      [g],
      [
        { gameId: 'hk', year: 2024, hoursTenths: 370, achievementsUnlocked: null },
        { gameId: 'hk', year: 2025, hoursTenths: 120, achievementsUnlocked: null },
      ],
    );
    expect(attributions.map((a) => [a.year, a.achievementsUnlocked])).toEqual([
      [2024, 46],
      [2025, 0],
    ]);
  });

  it('falls back to the first row when no row is the first-played year', () => {
    const { attributions } = attributeHours(
      [game({ id: 'x', firstPlayedYear: 2020, achievementsUnlocked: 10 })],
      [
        { gameId: 'x', year: 2023, hoursTenths: 10, achievementsUnlocked: null },
        { gameId: 'x', year: 2024, hoursTenths: 10, achievementsUnlocked: null },
      ],
    );
    expect(attributions.map((a) => [a.year, a.achievementsUnlocked])).toEqual([
      [2023, 10],
      [2024, 0],
    ]);
  });
});

describe('validateTrophySplit', () => {
  it('is satisfied by rows that say nothing about trophies', () => {
    expect(
      validateTrophySplit(46, [{ achievementsUnlocked: null }, { achievementsUnlocked: null }]),
    ).toMatchObject({ ok: true, specified: false });
  });

  it('requires the figures to add up to the earned count once any is given, a blank counting 0', () => {
    expect(
      validateTrophySplit(46, [{ achievementsUnlocked: 33 }, { achievementsUnlocked: 13 }]),
    ).toMatchObject({ ok: true, splitUnlocked: 46, earned: 46 });
    expect(
      validateTrophySplit(46, [{ achievementsUnlocked: 33 }, { achievementsUnlocked: null }]),
    ).toMatchObject({ ok: false, splitUnlocked: 33, earned: 46 });
    expect(validateTrophySplit(null, [{ achievementsUnlocked: 5 }])).toMatchObject({
      ok: false,
      earned: 0,
    });
  });
});
