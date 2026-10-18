/**
 * Compares the owner's "Game log" sheet export against the production
 * library, and writes the SQL that adds whatever the sheet has that the app
 * does not.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PURE. No database, no network, no environment variables.
 *
 * It reads two files the operator fetched by hand — the CSV the Google Sheet
 * exports, and a JSON array of the production `games` rows (read through the
 * Supabase MCP, saved verbatim) — and writes three files into --out:
 *
 *   report.md            the three-way comparison, for the owner to read
 *   report.json          the same, structured
 *   insert-missing.sql   one INSERT per "on sheet only" row the owner has
 *                        assigned a platform to, ON CONFLICT DO NOTHING
 *
 *   node scripts/diff-game-log.mjs <game-log.csv> <prod-games.json> \
 *     --owner-id <uuid> --out <dir> [--platforms <map.json>]
 *
 * --platforms GATES the SQL. The CSV cannot carry PS4-vs-PS5 (that was cell
 * colour in the sheet), so the section-walk guess the importer makes is a
 * hint, not a fact. The owner reads the report, assigns each missing title a
 * platform in a JSON map `{ "<title>": "ps5" | "ps4" | "psp" | "steam" | "pc" |
 * "other" }`, and only mapped titles get an INSERT; the rest are listed in the
 * SQL file's header as skipped — never guessed into the database.
 *
 * MATCHING. Exact on a folded title key first (`titleKey`: case, whitespace,
 * curly quotes, dashes), then `bestTitleMatchAmong` from the Games domain
 * core as a fuzzy second pass over the production rows nothing has claimed
 * yet. A HIGH-confidence fuzzy hit counts as matched but is flagged for
 * review; a LOW one is reported beside the "on sheet only" row as a near miss
 * and is never auto-matched — a false match would silently hide a missing
 * game, which is the one outcome this report exists to prevent. Platform is
 * never part of matching: production platforms were corrected after the
 * original import, so a mismatch is reported, not treated as a different game.
 *
 * Why a script and not a feature: this runs once, against a spreadsheet the
 * owner stopped maintaining when the app took over. Same shape as every other
 * one-off in this directory, and like them it imports the importer's own
 * parsers (`import-game-log.mjs` is import-safe by design) rather than
 * re-describing the sheet's quirks.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  buildColumnIndex,
  deriveStatus,
  findHeaderRowIndex,
  guessPlatform,
  parseFirstYear,
  parseHoursTenths,
  parseInteger,
  parsePriceCents,
  parseStarRating,
  realignRowFields,
  splitCsvLine,
  splitCsvRecords,
} from './import-game-log.mjs';
import { bestTitleMatchAmong } from '../src/server/games/metadata.ts';

const DATA_COLUMNS = [
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
const PLATFORMS = new Set(['ps5', 'ps4', 'psp', 'steam', 'pc', 'other']);

/**
 * The exact-match key: the same fold the retired duplicate-merge script used,
 * so a curly apostrophe, an em dash or a double space never makes two copies
 * of one title read as two games. Nothing fuzzy here — that is the second
 * pass's job.
 */
export function titleKey(title) {
  return title
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Walks the sheet exactly as `import-game-log.mjs` does — header located by
 * name, the one missing-spacer row realigned, the stateful section walk run
 * on EVERY row so it never desyncs, the first empty title ending the data —
 * and returns one object per game row. Throws on a sheet whose header cannot
 * be found, since every later number would be wrong rather than missing.
 */
export function parseSheet(raw) {
  const records = splitCsvRecords(raw);
  const headerIndex = findHeaderRowIndex(records);
  if (headerIndex === -1) {
    throw new Error(
      'Could not find the header row (expected a row whose fields include "Title", "Hours", and "Rating").',
    );
  }
  const columnIndex = buildColumnIndex(splitCsvLine(records[headerIndex]));
  const missing = DATA_COLUMNS.filter((column) => columnIndex[column] === -1);
  if (missing.length > 0)
    throw new Error(`Header row is missing expected column(s): ${missing.join(', ')}.`);

  const assignPlatform = guessPlatform();
  const rows = [];

  for (const [offset, record] of records.slice(headerIndex + 1).entries()) {
    const fields = realignRowFields(splitCsvLine(record));
    const title = fields[columnIndex.Title] ?? '';
    if (!title) break;
    if (title === '-') continue;

    const publisher = fields[columnIndex.Publisher] ?? '';
    const developer = fields[columnIndex.Developer] ?? '';
    const ownershipText = fields[columnIndex.Ownership] ?? '';
    const priceText = fields[columnIndex.Price] ?? '';
    const hoursText = fields[columnIndex.Hours] ?? '';
    const yearText = fields[columnIndex['First Played']] ?? '';
    const trophiesText = fields[columnIndex.Trophies] ?? '';
    const ratingText = fields[columnIndex.Rating] ?? '';

    const hoursTenths = parseHoursTenths(hoursText);
    const parsedRating = parseStarRating(ratingText);
    const rating =
      parsedRating !== null && parsedRating >= 1 && parsedRating <= 5 ? parsedRating : null;
    const guessedPlatform = assignPlatform(ownershipText, hoursText, yearText, trophiesText);

    rows.push({
      line: headerIndex + 2 + offset,
      title,
      developer: developer && developer !== '-' ? developer : null,
      publisher: publisher && publisher !== '-' ? publisher : null,
      ownership: /^physical$/i.test(ownershipText)
        ? 'physical'
        : /^digital$/i.test(ownershipText)
          ? 'digital'
          : null,
      priceCents: parsePriceCents(priceText),
      hoursTenths,
      hoursText,
      yearText,
      firstPlayedYear: parseFirstYear(yearText),
      achievementsUnlocked: parseInteger(trophiesText),
      rating,
      status: deriveStatus(hoursTenths, rating),
      guessedPlatform,
    });
  }

  return rows;
}

/**
 * The comparison. `prodRows` are production `games` rows as the database
 * returns them (snake_case). Returns four lists:
 *
 *   matched      sheet rows with a production row — `method: 'exact'`, or
 *                `'fuzzy'` with `review: true` and the similarity
 *   onSheetOnly  sheet rows with no production row; a LOW-confidence near
 *                miss, if any, rides along for the owner to judge
 *   inAppOnly    production rows no sheet row claimed (expected: games added
 *                through the app since the sheet was last maintained)
 *
 * `review` is the matched rows flagged for a human look, listed separately so
 * it is impossible to miss.
 */
export function diffGameLog(sheetRows, prodRows) {
  const byKey = new Map();
  for (const row of prodRows) {
    const key = titleKey(row.title);
    const list = byKey.get(key) ?? [];
    list.push(row);
    byKey.set(key, list);
  }

  const claimed = new Set();
  const matched = [];
  const onSheetOnly = [];

  for (const sheet of sheetRows) {
    const exact = (byKey.get(titleKey(sheet.title)) ?? []).filter((row) => !claimed.has(row.id));
    if (exact.length > 0) {
      // Several production rows can share a title (one per platform). Prefer
      // the one on the guessed platform; claim only that one, so a second
      // sheet row with the same title can still match the other.
      const pick = exact.find((row) => row.platform === sheet.guessedPlatform) ?? exact[0];
      claimed.add(pick.id);
      matched.push({
        sheetTitle: sheet.title,
        line: sheet.line,
        prodId: pick.id,
        prodTitle: pick.title,
        prodPlatform: pick.platform,
        guessedPlatform: sheet.guessedPlatform,
        platformMismatch: pick.platform !== sheet.guessedPlatform,
        method: 'exact',
        similarity: 1,
        review: false,
      });
      continue;
    }

    const unclaimed = prodRows.filter((row) => !claimed.has(row.id));
    const fuzzy = bestTitleMatchAmong(sheet.title, unclaimed, (row) => row.title);
    if (fuzzy !== null && fuzzy.score.confidence === 'high') {
      claimed.add(fuzzy.candidate.id);
      matched.push({
        sheetTitle: sheet.title,
        line: sheet.line,
        prodId: fuzzy.candidate.id,
        prodTitle: fuzzy.candidate.title,
        prodPlatform: fuzzy.candidate.platform,
        guessedPlatform: sheet.guessedPlatform,
        platformMismatch: fuzzy.candidate.platform !== sheet.guessedPlatform,
        method: 'fuzzy',
        similarity: fuzzy.score.similarity,
        review: true,
      });
      continue;
    }

    onSheetOnly.push({
      ...sheet,
      possibleCollection: sheet.title.includes(' - '),
      nearMiss:
        fuzzy === null
          ? null
          : { prodTitle: fuzzy.candidate.title, similarity: fuzzy.score.similarity },
    });
  }

  const inAppOnly = prodRows
    .filter((row) => !claimed.has(row.id))
    .map((row) => ({
      id: row.id,
      title: row.title,
      platform: row.platform,
      status: row.status,
      memberOfCollection: row.collection_id !== null && row.collection_id !== undefined,
    }));

  return {
    matched,
    review: matched.filter((entry) => entry.review),
    onSheetOnly,
    inAppOnly,
  };
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return `'${String(value).replace(/'/g, "''")}'`;
}
export { sqlLiteral };

/**
 * One INSERT per "on sheet only" row the owner has assigned a platform to —
 * the same column list and derivations `import-game-log.mjs` writes, with
 * ON CONFLICT DO NOTHING covering every unique index on `games` as the safety
 * net. The real guard is the report itself: a second run against a fresh
 * export produces an empty file. Titles with no platform in the map are
 * listed in the header and skipped, never guessed.
 */
export function renderInsertSql(diff, { ownerId, platforms, sourceName }) {
  const map = new Map(
    Object.entries(platforms ?? {}).map(([title, platform]) => [titleKey(title), platform]),
  );
  const lines = [];
  const skipped = [];
  const bad = [];

  for (const row of diff.onSheetOnly) {
    const platform = map.get(titleKey(row.title));
    if (platform === undefined) {
      skipped.push(row.title);
      continue;
    }
    if (!PLATFORMS.has(platform)) {
      bad.push(`${row.title} → ${platform}`);
      continue;
    }
    if (row.nearMiss !== null) {
      lines.push(
        `-- NEAR MISS: similar to "${row.nearMiss.prodTitle}" (${row.nearMiss.similarity.toFixed(2)}) — platform assigned by the owner, so inserted.`,
      );
    }
    if (row.possibleCollection) {
      lines.push(
        '-- POSSIBLE FLATTENED COLLECTION: fix the title and file its members in the app afterwards.',
      );
    }
    lines.push(
      'insert into games (owner_id, title, platform, developer, publisher, ownership, price_cents, status, rating, hours_tenths, first_played_year, achievements_unlocked, notes)',
      `values (${[
        sqlLiteral(ownerId),
        sqlLiteral(row.title),
        sqlLiteral(platform),
        sqlLiteral(row.developer),
        sqlLiteral(row.publisher),
        sqlLiteral(row.ownership),
        sqlLiteral(row.priceCents),
        sqlLiteral(row.status),
        sqlLiteral(row.rating),
        sqlLiteral(row.hoursTenths),
        sqlLiteral(row.firstPlayedYear),
        sqlLiteral(row.achievementsUnlocked),
        sqlLiteral(
          row.hoursText && row.hoursText.includes('+')
            ? `Imported as "${row.hoursText}" across ${row.yearText}`
            : null,
        ),
      ].join(', ')})`,
      'on conflict do nothing;',
      '',
    );
  }

  if (bad.length > 0) throw new Error(`Unknown platform in --platforms: ${bad.join('; ')}`);

  const header = [
    `-- Generated by scripts/diff-game-log.mjs from ${sourceName} on ${new Date().toISOString().slice(0, 10)}.`,
    `-- ${lines.filter((line) => line.startsWith('insert into')).length} insert(s). Platforms come from the owner's --platforms map, never from a guess.`,
    skipped.length === 0
      ? '-- Every "on sheet only" row has a platform assigned.'
      : `-- SKIPPED (no platform assigned): ${skipped.join(' | ')}`,
    'BEGIN;',
    '',
  ];
  return { sql: [...header, ...lines, 'COMMIT;', ''].join('\n'), skipped };
}

export function renderReport(diff, { sourceName, prodCount, sheetCount }) {
  const out = [];
  out.push(`# Game log vs. production — ${sourceName}`, '');
  out.push(
    `| | Count |`,
    `| --- | --- |`,
    `| Rows on the sheet | ${sheetCount} |`,
    `| Rows in production | ${prodCount} |`,
    `| Matched | ${diff.matched.length} |`,
    `| …of which need a look (fuzzy) | ${diff.review.length} |`,
    `| On sheet only | ${diff.onSheetOnly.length} |`,
    `| In app only | ${diff.inAppOnly.length} |`,
    '',
  );

  out.push('## On sheet only', '');
  if (diff.onSheetOnly.length === 0)
    out.push('Nothing — every sheet row has a production row.', '');
  else {
    out.push(
      '| Line | Title | Guessed platform | Status | Hours | Flags |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const row of diff.onSheetOnly) {
      const flags = [];
      if (row.possibleCollection) flags.push('possible flattened collection');
      if (row.nearMiss !== null)
        flags.push(
          `near miss: "${row.nearMiss.prodTitle}" (${row.nearMiss.similarity.toFixed(2)})`,
        );
      out.push(
        `| ${row.line} | ${escapeCell(row.title)} | ${row.guessedPlatform} | ${row.status} | ${row.hoursText || '—'} | ${flags.join('; ') || '—'} |`,
      );
    }
    out.push('');
  }

  out.push('## Review — matched by similarity, not exactly', '');
  if (diff.review.length === 0) out.push('None.', '');
  else {
    out.push(
      '| Line | Sheet title | Production title | Similarity | Platforms |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const row of diff.review) {
      out.push(
        `| ${row.line} | ${escapeCell(row.sheetTitle)} | ${escapeCell(row.prodTitle)} | ${row.similarity.toFixed(2)} | sheet ${row.guessedPlatform} / app ${row.prodPlatform} |`,
      );
    }
    out.push('');
  }

  out.push('## In app only', '');
  if (diff.inAppOnly.length === 0) out.push('None.', '');
  else {
    out.push('| Title | Platform | Status | Note |', '| --- | --- | --- | --- |');
    for (const row of diff.inAppOnly) {
      out.push(
        `| ${escapeCell(row.title)} | ${row.platform} | ${row.status} | ${row.memberOfCollection ? 'inside a collection' : ''} |`,
      );
    }
    out.push('');
  }

  out.push('## Matched', '');
  out.push(
    '| Line | Sheet title | Production title | Method | Platform |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const row of diff.matched) {
    out.push(
      `| ${row.line} | ${escapeCell(row.sheetTitle)} | ${escapeCell(row.prodTitle)} | ${row.method} | ${row.prodPlatform}${row.platformMismatch ? ` (sheet guessed ${row.guessedPlatform})` : ''} |`,
    );
  }
  out.push('');
  return out.join('\n');
}

function escapeCell(text) {
  return String(text).replace(/\|/g, '\\|');
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      options[arg.slice(2)] = argv[i + 1];
      i += 1;
    } else positional.push(arg);
  }
  return { positional, options };
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const [csvPath, jsonPath] = positional;
  if (!csvPath || !jsonPath || !options['owner-id'] || !options.out) {
    console.error(
      'Usage: node scripts/diff-game-log.mjs <game-log.csv> <prod-games.json> --owner-id <uuid> --out <dir> [--platforms <map.json>]',
    );
    process.exitCode = 2;
    return;
  }

  const sheetRows = parseSheet(fs.readFileSync(csvPath, 'utf8'));
  const prodRows = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (!Array.isArray(prodRows)) throw new Error(`${jsonPath} must hold a JSON array of games rows`);
  const platforms = options.platforms ? JSON.parse(fs.readFileSync(options.platforms, 'utf8')) : {};

  const diff = diffGameLog(sheetRows, prodRows);
  const sourceName = path.basename(csvPath);
  fs.mkdirSync(options.out, { recursive: true });
  fs.writeFileSync(
    path.join(options.out, 'report.md'),
    renderReport(diff, { sourceName, prodCount: prodRows.length, sheetCount: sheetRows.length }),
  );
  fs.writeFileSync(path.join(options.out, 'report.json'), JSON.stringify(diff, null, 2));
  const { sql, skipped } = renderInsertSql(diff, {
    ownerId: options['owner-id'],
    platforms,
    sourceName,
  });
  fs.writeFileSync(path.join(options.out, 'insert-missing.sql'), sql);

  console.log(
    `${sheetRows.length} sheet rows, ${prodRows.length} production rows → matched ${diff.matched.length} (${diff.review.length} to review), on sheet only ${diff.onSheetOnly.length}, in app only ${diff.inAppOnly.length}.`,
  );
  console.log(
    `Inserts written for ${diff.onSheetOnly.length - skipped.length}; ${skipped.length} skipped for lack of a platform.`,
  );
  console.log(`Wrote report.md, report.json and insert-missing.sql to ${options.out}`);
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  await main();
}
