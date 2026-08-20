import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildColumnIndex,
  deriveStatus,
  findHeaderRowIndex,
  guessPlatform,
  isLocalDatabaseUrl,
  parseFirstYear,
  parseHoursTenths,
  parseInteger,
  parsePriceCents,
  parseStarRating,
  realignRowFields,
  splitCsvLine,
  splitCsvRecords,
} from '../../scripts/import-game-log.mjs';

/**
 * These test the one-off historical-import script's pure parsing helpers
 * against the awkward shapes actually present in the owner's real "Game log"
 * spreadsheet (see .superpowers/sdd/2026-08-20-game-tracker/real-csv-analysis.md).
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

describe('splitCsvRecords', () => {
  it('keeps a plain single-line record intact', () => {
    expect(splitCsvRecords('a,b,c')).toEqual(['a,b,c']);
  });

  it('splits on unquoted newlines', () => {
    expect(splitCsvRecords('a,b\nc,d')).toEqual(['a,b', 'c,d']);
  });

  it('strips the trailing \\r from a CRLF-terminated record', () => {
    expect(splitCsvRecords('a,b\r\nc,d')).toEqual(['a,b', 'c,d']);
  });

  it('joins a quoted field that embeds a literal newline into ONE record, not two', () => {
    // Regression: the real export has exactly one title that spans two
    // physical lines this way ("Slay the Spire 2"). A naive
    // `raw.split(/\r?\n/)` would corrupt both fragments — this reproduces
    // the same shape with an invented title.
    const raw =
      'Title,Publisher,Developer,Ownership,Price,Hours,First Played,Trophies,Rating\n' +
      'Starfall Chronicles,Nova Interactive,Nova Interactive,Digital,39.99,24,2023,18,4\n' +
      '"Aurora Descent 2\n",Fablecraft,Fablecraft Studios,Digital,29.99,53,2024,27,5\n' +
      'Nightfall Requiem,Umbra Games,Umbra Games,Physical,44.99,18,2024,9,4';

    const records = splitCsvRecords(raw);
    expect(records).toHaveLength(4);

    const fields = splitCsvLine(records[2]);
    expect(fields[0]).toBe('Aurora Descent 2');
    expect(fields).toHaveLength(9);
  });
});

describe('findHeaderRowIndex', () => {
  it('finds a header row wherever it is, by its fields — not by line position', () => {
    // Regression: the real export's header starts with a leading empty
    // column before "Title" (`,Title,Publisher,...`), so the original
    // start-anchored regex never matched it at all.
    const records = [',,,,', ',GAME LOG,,,', ',Title,Publisher,Hours,Rating', ',Some Game,Some Pub,10,4'];
    expect(findHeaderRowIndex(records)).toBe(2);
  });

  it('returns -1 when no row carries all three signature columns', () => {
    expect(findHeaderRowIndex(['a,b,c', 'd,e,f'])).toBe(-1);
  });
});

describe('buildColumnIndex', () => {
  it('resolves every data column to its header position', () => {
    const header = [
      '',
      'Title',
      'Publisher',
      'Developer',
      'Ownership',
      'Price',
      'Hours',
      'First Played',
      'Trophies',
      'Rating',
    ];
    expect(buildColumnIndex(header)).toEqual({
      Title: 1,
      Publisher: 2,
      Developer: 3,
      Ownership: 4,
      Price: 5,
      Hours: 6,
      'First Played': 7,
      Trophies: 8,
      Rating: 9,
    });
  });

  it('reports a missing column as -1 rather than throwing', () => {
    expect(buildColumnIndex(['', 'Title', 'Hours', 'Rating']).Publisher).toBe(-1);
  });
});

describe('realignRowFields', () => {
  it('leaves a well-formed row (blank spacer field) unchanged', () => {
    const fields = ['', 'Some Game', 'Some Publisher'];
    expect(realignRowFields(fields)).toBe(fields);
  });

  it('splits a leading "-" placeholder off the fused field, matching the real export\'s missing-comma row', () => {
    // The real export's one affected row is missing its leading comma AND
    // its own spacer-column value was literally "-" — fused directly onto
    // the Title text with nothing between them. Recovering the true title
    // means splitting off just that one leading "-", not the whole field.
    const fields = ['-Wraithbound Saga', 'Nebula Press', 'Physical'];
    expect(realignRowFields(fields)).toEqual(['-', 'Wraithbound Saga', 'Nebula Press', 'Physical']);
  });

  it('prepends a blank spacer when the fused field does not start with "-"', () => {
    const fields = ['Some Fused Game', 'Some Publisher'];
    expect(realignRowFields(fields)).toEqual(['', 'Some Fused Game', 'Some Publisher']);
  });
});

describe('parseHoursTenths', () => {
  it('sums a composite "N + M" value into tenths', () => {
    expect(parseHoursTenths('53 + 6')).toBe(590);
  });

  it('converts a plain hour count to tenths', () => {
    expect(parseHoursTenths('24')).toBe(240);
  });

  it('handles a decimal hour count', () => {
    expect(parseHoursTenths('65.5')).toBe(655);
    expect(parseHoursTenths('2.56')).toBe(26);
    expect(parseHoursTenths('0.1')).toBe(1);
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
    expect(parseInteger('43 + 11')).toBe(54);
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

describe('parseStarRating', () => {
  it('counts 5 filled stars as 5', () => {
    expect(parseStarRating('★★★★★')).toBe(5);
  });

  it('counts 4 filled and 1 empty star as 4', () => {
    expect(parseStarRating('★★★★☆')).toBe(4);
  });

  it('returns null for "-"', () => {
    expect(parseStarRating('-')).toBeNull();
  });

  it('returns null for an empty field', () => {
    expect(parseStarRating('')).toBeNull();
  });

  it('is tolerant of a plain digit string', () => {
    expect(parseStarRating('3')).toBe(3);
  });

  it('reads an all-hollow rating as 0, not null — an actual zero rating, distinct from "unrated"', () => {
    expect(parseStarRating('☆☆☆☆☆')).toBe(0);
  });

  it('returns null for unrecognised text rather than silently counting zero stars', () => {
    expect(parseStarRating('N/A')).toBeNull();
  });
});

describe('guessPlatform', () => {
  it('assigns ps5 to rows before the retro block', () => {
    const assign = guessPlatform();
    expect(assign('Digital', '24', '2026', '18')).toBe('ps5');
    expect(assign('Physical', '10', '2025', '5')).toBe('ps5');
  });

  it('assigns psp to a row whose Ownership, Hours, First Played, and Trophies are ALL "-"', () => {
    const assign = guessPlatform();
    expect(assign('-', '-', '-', '-')).toBe('psp');
  });

  it('does not treat a row with only SOME dash fields as the retro block', () => {
    // A real "untracked" Steam title in the source sheet: Ownership and
    // First Played read "-", but Hours and Trophies carry real values — not
    // the all-four-dash retro signature, so it must not classify as psp.
    const assign = guessPlatform();
    expect(assign('-', '0', '-', '0')).toBe('ps5');
  });

  it('assigns steam to every row after the retro block ends, and never reverts', () => {
    const assign = guessPlatform();
    expect(assign('Digital', '10', '2020', '5')).toBe('ps5'); // before retro
    expect(assign('-', '-', '-', '-')).toBe('psp'); // enters retro
    expect(assign('Digital', '20', '2015', '10')).toBe('steam'); // first row after retro
    expect(assign('Digital', '5', '2010', '2')).toBe('steam'); // stays steam
    // Even a row that matches the all-dash signature again, after the
    // section has already moved on, stays 'steam' — the sheet has exactly
    // one contiguous retro block, not a repeatable pattern.
    expect(assign('-', '-', '-', '-')).toBe('steam');
  });

  it('is a fresh section walk each time it is called, not shared state', () => {
    const first = guessPlatform();
    first('-', '-', '-', '-'); // enters retro on the first assigner
    const second = guessPlatform();
    expect(second('Digital', '10', '2024', '5')).toBe('ps5');
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

  // A concrete interface (not `Record<string, number>`) so property access
  // stays a plain `number` under `noUncheckedIndexedAccess` — an index
  // signature would make every access `number | undefined` even though the
  // production script's `buildColumnIndex` (tested separately above, with
  // its own `Record<string, number>` shape) genuinely can return `-1` for a
  // column that isn't present. Here, the fixture's header is known-good.
  interface ColumnIndex {
    Title: number;
    Publisher: number;
    Developer: number;
    Ownership: number;
    Price: number;
    Hours: number;
    'First Played': number;
    Trophies: number;
    Rating: number;
  }

  async function loadFixture(): Promise<{ rows: string[][]; columnIndex: ColumnIndex }> {
    const raw = await readFile(fixturePath, 'utf8');
    const records = splitCsvRecords(raw).filter((record) => record.trim() !== '');
    const headerIndex = findHeaderRowIndex(records);
    expect(headerIndex).toBeGreaterThanOrEqual(0);

    const columnIndex = buildColumnIndex(splitCsvLine(records[headerIndex])) as unknown as ColumnIndex;
    const rows: string[][] = [];
    for (const record of records.slice(headerIndex + 1)) {
      const fields = realignRowFields(splitCsvLine(record));
      const title = fields[columnIndex.Title] ?? '';
      if (!title) break; // trailing summary rows start here
      rows.push(fields);
    }
    return { rows, columnIndex };
  }

  /** Look up a fixture row by title, failing loudly (not with `undefined`) if it's missing. */
  function requireRow(rows: string[][], columnIndex: ColumnIndex, title: string): string[] {
    const row = rows.find((fields) => fields[columnIndex.Title] === title);
    if (!row) throw new Error(`fixture row not found for title: ${title}`);
    return row;
  }

  it('finds the header row by its fields, not by line position', async () => {
    const raw = await readFile(fixturePath, 'utf8');
    const records = splitCsvRecords(raw).filter((record) => record.trim() !== '');
    // The fixture deliberately has 3 decorative lines before the header
    // (a blank row, a "GAME LOG" title row, another blank row), mirroring
    // the real export — proving detection isn't just "line 0".
    expect(findHeaderRowIndex(records)).toBe(3);
  });

  it('imports exactly the real game rows and stops before the trailing summary rows', async () => {
    const { rows, columnIndex } = await loadFixture();
    expect(rows).toHaveLength(14);
    const titles = rows.map((fields) => fields[columnIndex.Title]);
    expect(titles.every((title) => (title ?? '').length > 0)).toBe(true);
  });

  it('sums composite hours to 590 tenths for the composite-hours row', async () => {
    const { rows, columnIndex } = await loadFixture();
    const row = requireRow(rows, columnIndex, 'Aurora Descent');
    expect(parseHoursTenths(row[columnIndex.Hours])).toBe(590);
  });

  it('takes the started year for the composite-year row', async () => {
    const { rows, columnIndex } = await loadFixture();
    const row = requireRow(rows, columnIndex, 'Nightfall Requiem');
    expect(parseFirstYear(row[columnIndex['First Played']])).toBe(2024);
  });

  it('sums the composite, irregularly-spaced price on a comma-quoted title', async () => {
    const { rows, columnIndex } = await loadFixture();
    const row = requireRow(rows, columnIndex, 'Void Marauder: Ashen Edition, Deluxe');
    expect(parsePriceCents(row[columnIndex.Price])).toBe(7998);
  });

  it('imports the all-dash retro row with nulls, not zeros, everywhere but title and rating', async () => {
    const { rows, columnIndex } = await loadFixture();
    const row = requireRow(rows, columnIndex, 'Retro Quest I');
    expect(row[columnIndex.Publisher]).toBe('-');
    expect(row[columnIndex.Developer]).toBe('-');
    expect(row[columnIndex.Ownership]).toBe('-');
    expect(parsePriceCents(row[columnIndex.Price])).toBeNull();
    expect(parseHoursTenths(row[columnIndex.Hours])).toBeNull();
    expect(parseFirstYear(row[columnIndex['First Played']])).toBeNull();
    expect(parseInteger(row[columnIndex.Trophies])).toBeNull();
    expect(parseStarRating(row[columnIndex.Rating])).toBe(3);
    // The end-to-end proof for the status fix: this row has null hours (like
    // every retro row) but DOES carry a rating, and must import as
    // 'completed', not 'backlog' — the whole retro library hinges on this.
    expect(deriveStatus(parseHoursTenths(row[columnIndex.Hours]), parseStarRating(row[columnIndex.Rating]))).toBe(
      'completed',
    );
  });

  it('imports the collection sub-row with only a title and a year, price null', async () => {
    const { rows, columnIndex } = await loadFixture();
    const row = requireRow(rows, columnIndex, 'Starfall Chronicles: Remastered');
    expect(row[columnIndex.Publisher]).toBe('');
    expect(parsePriceCents(row[columnIndex.Price])).toBeNull();
    expect(parseHoursTenths(row[columnIndex.Hours])).toBeNull();
    expect(parseFirstYear(row[columnIndex['First Played']])).toBe(2023);
  });

  it('unescapes the embedded-quote title', async () => {
    const { rows, columnIndex } = await loadFixture();
    expect(rows.some((fields) => fields[columnIndex.Title] === 'Echoes of "Vale"')).toBe(true);
  });

  it('passes non-ASCII titles through cleanly', async () => {
    const { rows, columnIndex } = await loadFixture();
    expect(rows.some((fields) => fields[columnIndex.Title] === 'Kōhaku no Kaze')).toBe(true);
    expect(rows.some((fields) => fields[columnIndex.Title] === 'Widow’s Vigil')).toBe(true);
  });

  it('realigns the row missing its leading comma, recovering the real title and every shifted field', async () => {
    const { rows, columnIndex } = await loadFixture();
    const row = requireRow(rows, columnIndex, 'Wraithbound Saga: Chronicles of the Hollow King');
    expect(row[columnIndex.Publisher]).toBe('Nebula Press');
    expect(row[columnIndex.Developer]).toBe('Onyx Foundry, Starlight Co');
    expect(row[columnIndex.Ownership]).toBe('Physical');
    expect(parsePriceCents(row[columnIndex.Price])).toBe(5450);
    expect(parseHoursTenths(row[columnIndex.Hours])).toBe(610);
    expect(parseFirstYear(row[columnIndex['First Played']])).toBe(2023);
    expect(parseInteger(row[columnIndex.Trophies])).toBe(88);
    expect(parseStarRating(row[columnIndex.Rating])).toBe(5);
  });

  it('joins the multi-line quoted record into a single game with its real metadata intact', async () => {
    const { rows, columnIndex } = await loadFixture();
    const matches = rows.filter((fields) => fields[columnIndex.Title] === 'Void Requiem 2');
    expect(matches).toHaveLength(1);
    const row = matches[0]!;
    expect(row[columnIndex.Publisher]).toBe('Mega Forge Games');
    expect(parsePriceCents(row[columnIndex.Price])).toBe(2435);
    expect(parseStarRating(row[columnIndex.Rating])).toBe(0);
  });

  it('assigns platform by section position across the whole fixture, matching the owner\'s rule', async () => {
    const { rows, columnIndex } = await loadFixture();
    const assign = guessPlatform();
    const platforms = rows.map((fields) =>
      assign(
        fields[columnIndex.Ownership] ?? '',
        fields[columnIndex.Hours] ?? '',
        fields[columnIndex['First Played']] ?? '',
        fields[columnIndex.Trophies] ?? '',
      ),
    );
    // 10 modern rows before the retro block, 2 retro rows, then 2 rows in
    // the Steam/PC section after it.
    expect(platforms.slice(0, 10)).toEqual(new Array(10).fill('ps5'));
    expect(platforms.slice(10, 12)).toEqual(['psp', 'psp']);
    expect(platforms.slice(12)).toEqual(['steam', 'steam']);
  });
});
