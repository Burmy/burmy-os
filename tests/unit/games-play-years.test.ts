import { describe, expect, it } from 'vitest';

import {
  type AttributableGame,
  type PlayYearRow,
  attributeHours,
  validateSplit,
} from '@/server/games/play-years';

function game(overrides: Partial<AttributableGame> = {}): AttributableGame {
  return { id: 'game-1', firstPlayedYear: 2024, hoursTenths: 490, ...overrides };
}

describe('attributeHours', () => {
  it('attributes all hours to firstPlayedYear when a game has no split rows', () => {
    const result = attributeHours([game({ id: 'g1', firstPlayedYear: 2024, hoursTenths: 490 })], []);

    expect(result.attributions).toEqual([{ year: 2024, gameId: 'g1', hoursTenths: 490 }]);
    expect(result.unattributedTenths).toBe(0);
  });

  it('uses the split rows instead of firstPlayedYear when they exist', () => {
    const rows: PlayYearRow[] = [
      { gameId: 'g1', year: 2024, hoursTenths: 370 },
      { gameId: 'g1', year: 2025, hoursTenths: 120 },
    ];

    const result = attributeHours([game({ id: 'g1', firstPlayedYear: 2024, hoursTenths: 490 })], rows);

    expect(result.attributions).toEqual([
      { year: 2024, gameId: 'g1', hoursTenths: 370 },
      { year: 2025, gameId: 'g1', hoursTenths: 120 },
    ]);
    expect(result.unattributedTenths).toBe(0);
  });

  it('excludes a game with no year and no split rows rather than bucketing it at year zero', () => {
    const result = attributeHours([game({ id: 'g1', firstPlayedYear: null })], []);

    expect(result.attributions).toEqual([]);
  });

  it('still attributes a game with no firstPlayedYear when it has explicit split rows', () => {
    const rows: PlayYearRow[] = [{ gameId: 'g1', year: 2019, hoursTenths: 80 }];

    const result = attributeHours([game({ id: 'g1', firstPlayedYear: null, hoursTenths: 80 })], rows);

    expect(result.attributions).toEqual([{ year: 2019, gameId: 'g1', hoursTenths: 80 }]);
  });

  it('treats a null total as zero hours', () => {
    const result = attributeHours([game({ id: 'g1', firstPlayedYear: 2020, hoursTenths: null })], []);

    expect(result.attributions).toEqual([{ year: 2020, gameId: 'g1', hoursTenths: 0 }]);
  });

  it('reports the remainder when a split does not account for the whole total', () => {
    // Steam moved the total to 51.0h; the owner's split still says 37 + 12 = 49.0h.
    const rows: PlayYearRow[] = [
      { gameId: 'g1', year: 2024, hoursTenths: 370 },
      { gameId: 'g1', year: 2025, hoursTenths: 120 },
    ];

    const result = attributeHours([game({ id: 'g1', hoursTenths: 510 })], rows);

    expect(result.unattributedTenths).toBe(20);
  });

  it('reports a NEGATIVE remainder when a split over-accounts for the total', () => {
    const rows: PlayYearRow[] = [{ gameId: 'g1', year: 2024, hoursTenths: 600 }];

    const result = attributeHours([game({ id: 'g1', hoursTenths: 490 })], rows);

    expect(result.unattributedTenths).toBe(-110);
  });

  it('ignores split rows belonging to a game not in the list', () => {
    const rows: PlayYearRow[] = [{ gameId: 'ghost', year: 2024, hoursTenths: 999 }];

    const result = attributeHours([game({ id: 'g1', firstPlayedYear: 2024, hoursTenths: 490 })], rows);

    expect(result.attributions).toEqual([{ year: 2024, gameId: 'g1', hoursTenths: 490 }]);
    expect(result.unattributedTenths).toBe(0);
  });

  it('sums remainders across several games', () => {
    const games = [game({ id: 'g1', hoursTenths: 510 }), game({ id: 'g2', hoursTenths: 200 })];
    const rows: PlayYearRow[] = [
      { gameId: 'g1', year: 2024, hoursTenths: 490 },
      { gameId: 'g2', year: 2024, hoursTenths: 150 },
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
