import { describe, expect, it } from 'vitest';

import {
  diffGameLog,
  parseSheet,
  renderInsertSql,
  renderReport,
  sqlLiteral,
  titleKey,
} from '../../scripts/diff-game-log.mjs';

/**
 * The one-off sheet-vs-production diff (`scripts/diff-game-log.mjs`) is pure
 * — no database, no network — so everything it decides is testable here with
 * inline fixtures. The CSV shape mirrors the real export the importer was
 * written against: three decorative lines, a header with a leading spacer
 * column, every data row starting with a blank field, a footer row with an
 * empty title.
 */
const CSV = [
  ',GAME LOG,,,,,,,,',
  ',,,,,,,,,',
  ',,,,,,,,,',
  ',Title,Publisher,Developer,Ownership,Price,Hours,First Played,Trophies,Rating',
  ',Elden Ring (PS5),Bandai Namco,FromSoftware,Physical,$59.99,136,2022,42,★★★★★',
  ',Hadez,-,-,Digital,$24.99,53 + 6,2024 + 2025,10,★★★★',
  ',Brand New Game,-,-,-,-,-,-,-,★★★',
  ",Nathan Drake Collection - Uncharted: Drake's Fortune,Sony,Naughty Dog,Physical,$19.99,44,2021,154,★★★★",
  ',Unknown Retro,-,-,-,-,-,-,-,★★',
  ',,160 Games,,Physical: 38,$ 2306.,3137.44 Hrs,,,',
].join('\n');

function prod(overrides: Record<string, unknown>) {
  return {
    id: 'id',
    title: 'Title',
    platform: 'ps5',
    status: 'played',
    collection_id: null,
    ...overrides,
  };
}

describe('titleKey', () => {
  it('folds case, whitespace, curly quotes and dashes', () => {
    expect(titleKey('Uncharted:  Drake’s  Fortune')).toBe("uncharted: drake's fortune");
    expect(titleKey('Half–Life 2')).toBe('half-life 2');
    expect(titleKey('  “Quoted”  ')).toBe('"quoted"');
  });
});

describe('parseSheet', () => {
  const rows = parseSheet(CSV);

  it('walks the sheet exactly as the importer does — header by name, footer ends the data', () => {
    expect(rows.map((row) => row.title)).toEqual([
      'Elden Ring (PS5)',
      'Hadez',
      'Brand New Game',
      "Nathan Drake Collection - Uncharted: Drake's Fortune",
      'Unknown Retro',
    ]);
  });

  it('parses hours, money, years, trophies, rating and status the same way the importer does', () => {
    const hadez = rows[1]!;
    expect(hadez.hoursTenths).toBe(590);
    expect(hadez.hoursText).toBe('53 + 6');
    expect(hadez.firstPlayedYear).toBe(2024);
    expect(hadez.priceCents).toBe(2499);
    expect(hadez.achievementsUnlocked).toBe(10);
    expect(hadez.rating).toBe(4);
    expect(hadez.status).toBe('played');
    expect(hadez.ownership).toBe('digital');
    expect(hadez.developer).toBeNull();
  });

  it('runs the section walk on every row, so the retro block flips the guess to psp', () => {
    expect(rows.map((row) => row.guessedPlatform)).toEqual(['ps5', 'ps5', 'psp', 'steam', 'steam']);
  });

  it('throws when the header cannot be found rather than producing an empty, confident report', () => {
    expect(() => parseSheet('a,b,c\n1,2,3')).toThrow(/header row/);
  });
});

describe('diffGameLog', () => {
  const sheet = parseSheet(CSV);
  const production = [
    prod({ id: 'er', title: 'Elden Ring', platform: 'ps5' }),
    prod({ id: 'hades', title: 'Hades', platform: 'steam' }),
    prod({ id: 'app-only', title: 'Added In App', platform: 'ps5', status: 'wanted' }),
    prod({ id: 'member', title: 'Inside A Set', platform: 'ps4', collection_id: 'ndc' }),
  ];
  const diff = diffGameLog(sheet, production);

  it('matches a trailing-parenthetical title by similarity, flagged for review', () => {
    const elden = diff.matched.find((row) => row.sheetTitle === 'Elden Ring (PS5)');
    expect(elden).toMatchObject({ prodTitle: 'Elden Ring', method: 'fuzzy', review: true });
    expect(diff.review.map((row) => row.sheetTitle)).toEqual(['Elden Ring (PS5)']);
  });

  it('reports a low-confidence near miss beside the sheet row instead of matching it', () => {
    const hadez = diff.onSheetOnly.find((row) => row.title === 'Hadez');
    expect(hadez?.nearMiss).toMatchObject({ prodTitle: 'Hades' });
    expect(hadez?.nearMiss?.similarity).toBeGreaterThanOrEqual(0.7);
    expect(diff.matched.find((row) => row.prodTitle === 'Hades')).toBeUndefined();
  });

  it('lists a sheet row with no production row at all, with no near miss', () => {
    const fresh = diff.onSheetOnly.find((row) => row.title === 'Brand New Game');
    expect(fresh?.nearMiss).toBeNull();
    expect(fresh?.possibleCollection).toBe(false);
  });

  it('flags a title shaped like a flattened collection', () => {
    const flattened = diff.onSheetOnly.find((row) =>
      row.title.startsWith('Nathan Drake Collection - '),
    );
    expect(flattened?.possibleCollection).toBe(true);
  });

  it('lists production rows no sheet row claimed, with status and collection membership', () => {
    expect(diff.inAppOnly).toEqual([
      {
        id: 'hades',
        title: 'Hades',
        platform: 'steam',
        status: 'played',
        memberOfCollection: false,
      },
      {
        id: 'app-only',
        title: 'Added In App',
        platform: 'ps5',
        status: 'wanted',
        memberOfCollection: false,
      },
      {
        id: 'member',
        title: 'Inside A Set',
        platform: 'ps4',
        status: 'played',
        memberOfCollection: true,
      },
    ]);
  });

  it('matches exactly on the folded key, preferring the row on the guessed platform, and flags a platform mismatch', () => {
    const twice = diffGameLog(
      parseSheet(
        [
          ',Title,Publisher,Developer,Ownership,Price,Hours,First Played,Trophies,Rating',
          ',Uncharted 4,-,-,Physical,-,20,2019,-,★★★★',
        ].join('\n'),
      ),
      [
        prod({ id: 'u4-ps4', title: 'Uncharted 4', platform: 'ps4' }),
        prod({ id: 'u4-ps5', title: 'UNCHARTED 4', platform: 'ps5' }),
      ],
    );
    expect(twice.matched).toHaveLength(1);
    expect(twice.matched[0]).toMatchObject({
      prodId: 'u4-ps5',
      method: 'exact',
      platformMismatch: false,
    });
    expect(twice.inAppOnly.map((row: { readonly id: string }) => row.id)).toEqual(['u4-ps4']);
  });
});

describe('renderInsertSql', () => {
  const diff = diffGameLog(parseSheet(CSV), [
    prod({ id: 'er', title: 'Elden Ring' }),
    prod({ id: 'hades', title: 'Hades', platform: 'steam' }),
  ]);

  it('emits an INSERT only for titles the owner assigned a platform to, and lists the rest as skipped', () => {
    const { sql, skipped } = renderInsertSql(diff, {
      ownerId: 'owner-1',
      platforms: { Hadez: 'steam', 'brand new game': 'ps4' },
      sourceName: 'game-log.csv',
    });

    expect(sql).toContain("'Hadez', 'steam'");
    expect(sql).toContain("'Brand New Game', 'ps4'");
    expect(sql).toContain('on conflict do nothing;');
    expect(sql).toContain('-- NEAR MISS: similar to "Hades"');
    expect(sql).toContain('Imported as "53 + 6" across 2024 + 2025');
    expect(sql.startsWith('-- Generated by scripts/diff-game-log.mjs')).toBe(true);
    expect(sql).toContain('BEGIN;');
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(skipped).toEqual([
      "Nathan Drake Collection - Uncharted: Drake's Fortune",
      'Unknown Retro',
    ]);
    expect(sql).toContain('-- SKIPPED (no platform assigned): Nathan Drake Collection');
  });

  it('refuses an unknown platform rather than writing it', () => {
    expect(() =>
      renderInsertSql(diff, {
        ownerId: 'owner-1',
        platforms: { Hadez: 'switch' },
        sourceName: 'x.csv',
      }),
    ).toThrow(/Unknown platform/);
  });

  it('escapes a quote in a title', () => {
    expect(sqlLiteral("O'Neil")).toBe("'O''Neil'");
    expect(sqlLiteral(null)).toBe('NULL');
    expect(sqlLiteral(42)).toBe('42');
  });
});

describe('renderReport', () => {
  it('leads with the counts and lists every section', () => {
    const diff = diffGameLog(parseSheet(CSV), [
      prod({ id: 'er', title: 'Elden Ring' }),
      prod({ id: 'hades', title: 'Hades', platform: 'steam' }),
    ]);
    const report = renderReport(diff, { sourceName: 'game-log.csv', prodCount: 2, sheetCount: 5 });
    expect(report).toContain('| Rows on the sheet | 5 |');
    expect(report).toContain('## On sheet only');
    expect(report).toContain('## Review — matched by similarity, not exactly');
    expect(report).toContain('## In app only');
    expect(report).toContain('possible flattened collection');
    expect(report).toContain('near miss: "Hades"');
  });
});
