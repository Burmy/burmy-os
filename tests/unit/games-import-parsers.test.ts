import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  deriveStatus,
  guessPlatform,
  isLocalDatabaseUrl,
  parseFirstYear,
  parseHoursTenths,
  parseInteger,
  parsePriceCents,
  splitCsvLine,
} from '../../scripts/import-game-log.mjs';

/**
 * These test the one-off historical-import script's pure parsing helpers
 * against the awkward shapes actually present in the owner's real "Game log"
 * spreadsheet (see .superpowers/sdd/2026-08-20-game-tracker/task-9-brief.md).
 * The fixture below reproduces those shapes with invented game data — never
 * the owner's real library — so the parsers can be verified without ever
 * touching real personal data or a database.
 *
 * The single most damaging bug this script could have is treating "unknown"
 * ("-" or "") as 0 rather than null: that would silently fabricate 0-hour,
 * $0 entries across the entire pre-2015 retro library, which real rows DO
 * have real hours/prices for the SQL layer to be confused by. Every numeric
 * parser is tested explicitly for null-not-zero below.
 */

describe('splitCsvLine', () => {
  it('splits a plain row on commas', () => {
    expect(splitCsvLine('Starfall Chronicles,Nova Interactive,Nova Interactive,Digital,39.99,24,2023,18,4')).toEqual(
      ['Starfall Chronicles', 'Nova Interactive', 'Nova Interactive', 'Digital', '39.99', '24', '2023', '18', '4'],
    );
  });

  it('keeps a comma inside a quoted title as part of one field', () => {
    const fields = splitCsvLine(
      '"Void Marauder: Ashen Edition, Deluxe",Ferrous Interactive,Ferrous Interactive,Digital,49.99 +29.99,53,2025,15,4',
    );
    expect(fields[0]).toBe('Void Marauder: Ashen Edition, Deluxe');
    expect(fields).toHaveLength(9);
  });

  it('unescapes a CSV-doubled quote inside a quoted title', () => {
    const fields = splitCsvLine('"Echoes of ""Vale""",Halcyon Software,Halcyon Software,Digital,19.99,8,2021,5,3');
    expect(fields[0]).toBe('Echoes of "Vale"');
  });

  it('preserves trailing empty fields rather than dropping them', () => {
    const fields = splitCsvLine('Starfall Chronicles: Remastered,,,,,,2023,,');
    expect(fields).toEqual(['Starfall Chronicles: Remastered', '', '', '', '', '', '2023', '', '']);
    expect(fields).toHaveLength(9);
  });

  it('passes non-ASCII titles through untouched', () => {
    expect(splitCsvLine('Kōhaku no Kaze,Amber Sky,Amber Sky Studio,Digital,34.99,42,2020,20,4')[0]).toBe(
      'Kōhaku no Kaze',
    );
    expect(splitCsvLine('Widow’s Vigil,Thornback,Thornback Games,Physical,24.99,15,2019,12,3')[0]).toBe(
      'Widow’s Vigil',
    );
  });
});

describe('parseHoursTenths', () => {
  it('sums a composite "N + M" value into tenths', () => {
    expect(parseHoursTenths('53 + 6')).toBe(590);
  });

  it('converts a plain hour count to tenths', () => {
    expect(parseHoursTenths('24')).toBe(240);
  });

  it('returns null, never 0, for "-", empty, and whitespace-only', () => {
    expect(parseHoursTenths('-')).toBeNull();
    expect(parseHoursTenths('')).toBeNull();
    // Regression: '   '.trim() -> '', but Number('') is 0, not NaN — without
    // trimming BEFORE the empty check, whitespace-only input silently summed
    // to a false 0 instead of returning null. The one bug this script must
    // never have is treating "unknown" as "zero".
    expect(parseHoursTenths('   ')).toBeNull();
  });
});

describe('parseFirstYear', () => {
  it('takes the FIRST year of a composite "started + finished" value', () => {
    expect(parseFirstYear('2024 + 2025')).toBe(2024);
  });

  it('parses a plain year', () => {
    expect(parseFirstYear('2023')).toBe(2023);
  });

  it('returns null, never 0, for "-", empty, and whitespace-only', () => {
    expect(parseFirstYear('-')).toBeNull();
    expect(parseFirstYear('')).toBeNull();
    // Regression: this one only avoided returning 0 for '   ' BY ACCIDENT —
    // Number('') is 0, and 0 happens to fail the `> 1970` range check below.
    // Trimming before the empty check now makes that a guarantee, not luck.
    expect(parseFirstYear('   ')).toBeNull();
  });

  it('rejects an out-of-range value rather than trusting garbage', () => {
    expect(parseFirstYear('18')).toBeNull();
    expect(parseFirstYear('20245')).toBeNull();
  });
});

describe('parseInteger', () => {
  it('parses a plain integer', () => {
    expect(parseInteger('18')).toBe(18);
  });

  it('sums a composite value, same rule as hours', () => {
    expect(parseInteger('10 + 5')).toBe(15);
  });

  it('returns null, never 0, for "-", empty, and whitespace-only', () => {
    expect(parseInteger('-')).toBeNull();
    expect(parseInteger('')).toBeNull();
    expect(parseInteger('   ')).toBeNull();
  });
});

describe('parsePriceCents', () => {
  it('sums a composite price with irregular spacing around "+"', () => {
    expect(parsePriceCents('49.99 +29.99')).toBe(7998);
  });

  it('parses a plain price', () => {
    expect(parsePriceCents('69.99')).toBe(6999);
  });

  it('strips a leading dollar sign', () => {
    expect(parsePriceCents('$59.99')).toBe(5999);
  });

  it('returns null, never 0, for "-", empty, and whitespace-only', () => {
    expect(parsePriceCents('-')).toBeNull();
    expect(parsePriceCents('')).toBeNull();
    expect(parsePriceCents('   ')).toBeNull();
  });
});

describe('guessPlatform', () => {
  it('matches a PSP hint in the title', () => {
    expect(guessPlatform('Some Game (PSP)')).toBe('psp');
  });

  it('matches a PS4 hint in the title', () => {
    expect(guessPlatform('Some Game (PS4)')).toBe('ps4');
  });

  it('matches a Steam hint in the title', () => {
    expect(guessPlatform('Some Game (Steam)')).toBe('steam');
  });

  it('matches a standalone PC hint in the title', () => {
    expect(guessPlatform('Some Game (PC)')).toBe('steam');
  });

  it('does not treat "pc" inside an unrelated word as a platform hint', () => {
    // Regression: the original /steam|pc/i pattern matched "pc" as an
    // unanchored substring anywhere in the title, so a title or developer
    // token like "Capcom" produced a false Steam guess with nothing to do
    // with the actual platform.
    expect(guessPlatform('Capcom Arcade Stadium')).toBe('other');
  });

  it('defaults to "other" — the column\'s own default — when no hint matches', () => {
    // The source sheet has no Platform column at all, so anything without an
    // explicit in-title hint is genuinely unknown. There is no fallback
    // guess from the first-played year: a year carries no platform
    // information whatsoever.
    expect(guessPlatform('Crimson Labyrinth')).toBe('other');
  });
});

describe('deriveStatus', () => {
  it('reads as completed when hours are logged', () => {
    expect(deriveStatus(590, null)).toBe('completed');
  });

  it('reads as completed when a rating is on record even with no hours', () => {
    // This is the retro-library case: every pre-2015 row has null hours by
    // definition (all fields but Title/Rating are "-"), but a 1-5 rating is
    // only meaningful for a game the owner actually played. Using
    // hours-null alone as "backlog" would mislabel the whole retro block as
    // never-started.
    expect(deriveStatus(null, 4)).toBe('completed');
  });

  it('reads as backlog only when neither hours nor a rating is on record', () => {
    expect(deriveStatus(null, null)).toBe('backlog');
  });
});

describe('isLocalDatabaseUrl', () => {
  it('accepts localhost, 127.0.0.1, and bracketed IPv6 loopback', () => {
    expect(isLocalDatabaseUrl('postgres://burmy:burmy@localhost:5432/burmy')).toBe(true);
    expect(isLocalDatabaseUrl('postgres://burmy:burmy@127.0.0.1:5432/burmy')).toBe(true);
    expect(isLocalDatabaseUrl('postgres://burmy:burmy@[::1]:5432/burmy')).toBe(true);
  });

  it('rejects a remote host', () => {
    expect(isLocalDatabaseUrl('postgres://user:pass@db.supabase.co:5432/burmy')).toBe(false);
  });

  it('fails closed (treats as non-local) rather than throwing on a malformed URL', () => {
    expect(isLocalDatabaseUrl('not-a-url')).toBe(false);
  });
});

describe('the synthetic fixture, parsed end to end', () => {
  const fixturePath = path.resolve(process.cwd(), 'tests/fixtures/games/game-log-sample.csv');

  async function parsedRows(): Promise<string[][]> {
    const raw = await readFile(fixturePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '');
    const header = lines.findIndex((line) => /^\s*"?Title"?\s*,/i.test(line));
    expect(header).toBeGreaterThanOrEqual(0);
    return lines.slice(header + 1).map(splitCsvLine);
  }

  /** Look up a fixture row by title, failing loudly (not with `undefined`) if it's missing. */
  function requireRow(rows: string[][], title: string): string[] {
    const row = rows.find(([rowTitle]) => rowTitle === title);
    if (!row) throw new Error(`fixture row not found for title: ${title}`);
    return row;
  }

  it('finds the header row', async () => {
    const raw = await readFile(fixturePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '');
    expect(lines.findIndex((line) => /^\s*"?Title"?\s*,/i.test(line))).toBe(0);
  });

  it('sums composite hours to 590 tenths for the composite-hours row', async () => {
    const rows = await parsedRows();
    const row = requireRow(rows, 'Aurora Descent');
    expect(parseHoursTenths(row[5])).toBe(590);
  });

  it('takes the started year for the composite-year row', async () => {
    const rows = await parsedRows();
    const row = requireRow(rows, 'Nightfall Requiem');
    expect(parseFirstYear(row[6])).toBe(2024);
  });

  it('sums the composite, irregularly-spaced price on a comma-quoted title', async () => {
    const rows = await parsedRows();
    const row = requireRow(rows, 'Void Marauder: Ashen Edition, Deluxe');
    expect(parsePriceCents(row[4])).toBe(7998);
  });

  it('imports the all-dash retro row with nulls, not zeros, everywhere but title and rating', async () => {
    const rows = await parsedRows();
    const [, publisher, developer, ownership, price, hours, year, trophies, rating] = requireRow(
      rows,
      'Crimson Labyrinth',
    );
    expect(publisher).toBe('-');
    expect(developer).toBe('-');
    expect(ownership).toBe('-');
    expect(parsePriceCents(price)).toBeNull();
    expect(parseHoursTenths(hours)).toBeNull();
    expect(parseFirstYear(year)).toBeNull();
    expect(parseInteger(trophies)).toBeNull();
    expect(parseInteger(rating)).toBe(3);
    // The end-to-end proof for the status fix: this row has null hours (like
    // every retro row) but DOES carry a rating, and must import as
    // 'completed', not 'backlog' — the whole retro library hinges on this.
    expect(deriveStatus(parseHoursTenths(hours), parseInteger(rating))).toBe('completed');
  });

  it('imports the collection sub-row with only a title and a year, price null', async () => {
    const rows = await parsedRows();
    const [, publisher, , , price, hours, year] = requireRow(rows, 'Starfall Chronicles: Remastered');
    expect(publisher).toBe('');
    expect(parsePriceCents(price)).toBeNull();
    expect(parseHoursTenths(hours)).toBeNull();
    expect(parseFirstYear(year)).toBe(2023);
  });

  it('unescapes the embedded-quote title', async () => {
    const rows = await parsedRows();
    expect(rows.some(([title]) => title === 'Echoes of "Vale"')).toBe(true);
  });

  it('passes non-ASCII titles through cleanly', async () => {
    const rows = await parsedRows();
    expect(rows.some(([title]) => title === 'Kōhaku no Kaze')).toBe(true);
    expect(rows.some(([title]) => title === 'Widow’s Vigil')).toBe(true);
  });
});
