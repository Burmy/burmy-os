/**
 * One-off import of the owner's historical "Game log" Google Sheet.
 *
 * Run manually, once. Not wired into any product flow, not a feature. Reads a
 * CSV the owner exported by hand and writes `games` rows.
 *
 * Safety: refuses to run against anything but a local database, and refuses
 * to run if the games table already has rows (re-running would duplicate the
 * library, and the unique index would half-fail partway through).
 *
 * WHY PLAIN ESM AND NOT TYPESCRIPT
 *
 * Same reasoning as scripts/migrate.mjs: this only needs to read a CSV and
 * run a few inserts, so it needs nothing but `postgres`, already a production
 * dependency. No tsx -> esbuild -> native-binary chain for that.
 *
 * TESTABILITY
 *
 * The pure parsing helpers below are `export`ed so tests/unit/games-import-
 * parsers.test.ts can exercise them directly. That only works safely because
 * the CLI body lives in `main()` and is invoked ONLY when this file is run
 * directly (guarded below via `import.meta.url`) — importing this module for
 * its exports must never open a database connection or touch `process.argv`.
 */

import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';

const PLATFORM_BY_HINT = [
  [/psp|playstation portable/i, 'psp'],
  [/ps4|playstation 4/i, 'ps4'],
  [/steam|pc/i, 'steam'],
];

// Same set src/server/db/seed-guard.ts uses for the identical `db:seed`
// local-only guard. Duplicated rather than imported: that module is
// TypeScript, and this script stays plain ESM on purpose (see house-style
// note above) — importing a .ts file from a .mjs script would need a loader
// this script deliberately has no reason to carry.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Split a CSV line honouring quoted fields — titles contain commas. */
export function splitCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields.map((field) => field.trim());
}

/** "53 + 6" -> 590 tenths. "-" / "" -> null, never 0 — unknown is not zero. */
export function parseHoursTenths(raw) {
  if (!raw || raw === '-') return null;
  const parts = raw
    .split('+')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n));
  if (parts.length === 0) return null;
  return Math.round(parts.reduce((sum, n) => sum + n, 0) * 10);
}

/** "2024 + 2025" -> 2024 (when it was STARTED, the first component). "-" -> null. */
export function parseFirstYear(raw) {
  if (!raw || raw === '-') return null;
  const first = Number(raw.split('+')[0]?.trim());
  return Number.isInteger(first) && first > 1970 && first < 2100 ? first : null;
}

/** Plain or composite ("+"-summed) integer field. "-" / "" -> null, never 0. */
export function parseInteger(raw) {
  if (!raw || raw === '-') return null;
  const parts = raw
    .split('+')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n));
  if (parts.length === 0) return null;
  return Math.round(parts.reduce((sum, n) => sum + n, 0));
}

/** "$49.99 +29.99" -> 7998 cents. "-" / "" -> null, never 0. */
export function parsePriceCents(raw) {
  if (!raw || raw === '-') return null;
  const parts = raw
    .replace(/\$/g, '')
    .split('+')
    .map((p) => Number(p.trim()))
    .filter((n) => Number.isFinite(n));
  if (parts.length === 0) return null;
  return Math.round(parts.reduce((sum, n) => sum + n, 0) * 100);
}

/**
 * The source sheet has no Platform column, so this is a heuristic guess from
 * the title text and the first-played year, not a parse of recorded data.
 */
export function guessPlatform(title, firstYear) {
  for (const [pattern, platform] of PLATFORM_BY_HINT) {
    if (pattern.test(title)) return platform;
  }
  // The retro block (no year recorded at all) is the PSP-era library.
  if (firstYear === null) return 'psp';
  if (firstYear <= 2020) return 'ps4';
  return 'ps5';
}

/**
 * Whether a Postgres connection string points at a local database.
 *
 * `new URL()` parses a `postgres://`/`postgresql://` connection string
 * directly — Node's URL parser recognises the `user:pass@host:port`
 * authority for any scheme followed by `//`, verified against this project's
 * own local DATABASE_URL shape, so no scheme-swap trick is needed. An IPv6
 * loopback comes back from `.hostname` WITH its brackets (`"[::1]"`,
 * verified empirically) — that literal bracketed form has to be in the
 * allowlist too, alongside bare `"::1"`, matching seed-guard.ts's set.
 * Unparsable input is treated as non-local (fail closed, not fail open).
 */
export function isLocalDatabaseUrl(url) {
  try {
    return LOCAL_HOSTNAMES.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

async function main() {
  const [, , csvPath, ownerEmail] = process.argv;

  if (!csvPath || !ownerEmail) {
    console.error('Usage: node scripts/import-game-log.mjs <path-to-csv> <owner-email>');
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  if (!isLocalDatabaseUrl(databaseUrl)) {
    console.error(
      'Refusing to run against a non-local database. Import locally, then migrate the data deliberately.',
    );
    process.exit(1);
  }

  const email = ownerEmail.trim().toLowerCase();
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    const [owner] = await sql`select id from "user" where email = ${email} limit 1`;
    if (!owner) {
      console.error(`No user row for ${email}. Provision the owner first.`);
      process.exitCode = 1;
      return;
    }

    const [{ count }] = await sql`select count(*)::int as count from games where owner_id = ${owner.id}`;
    if (count > 0) {
      console.error(`Refusing to import: ${count} games already exist for ${email}. Clear them first if this is a re-run.`);
      process.exitCode = 1;
      return;
    }

    const raw = await readFile(csvPath, 'utf8');
    const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '');
    const header = lines.findIndex((line) => /^\s*"?Title"?\s*,/i.test(line));
    if (header === -1) {
      console.error('Could not find the header row (expected a line starting with "Title,").');
      process.exitCode = 1;
      return;
    }

    let imported = 0;
    let skipped = 0;

    for (const line of lines.slice(header + 1)) {
      const [title, publisher, developer, ownership, price, hoursText, yearText, trophies, rating] =
        splitCsvLine(line);
      if (!title || title === '-') {
        skipped += 1;
        continue;
      }

      const firstPlayedYear = parseFirstYear(yearText);
      const hoursTenths = parseHoursTenths(hoursText);
      const ratingValue = parseInteger(rating);

      const result = await sql`
        insert into games (
          owner_id, title, platform, developer, publisher, ownership, price_cents,
          status, rating, hours_tenths, first_played_year, achievements_unlocked, notes
        ) values (
          ${owner.id}, ${title}, ${guessPlatform(title, firstPlayedYear)},
          ${developer && developer !== '-' ? developer : null},
          ${publisher && publisher !== '-' ? publisher : null},
          ${/^physical$/i.test(ownership) ? 'physical' : /^digital$/i.test(ownership) ? 'digital' : null},
          ${parsePriceCents(price)},
          ${hoursTenths === null ? 'backlog' : 'completed'},
          ${ratingValue !== null && ratingValue >= 1 && ratingValue <= 5 ? ratingValue : null},
          ${hoursTenths},
          ${firstPlayedYear},
          ${parseInteger(trophies)},
          ${hoursText && hoursText.includes('+') ? `Imported as "${hoursText}" across ${yearText}` : null}
        )
        on conflict do nothing
      `;

      // `on conflict do nothing` means a row can be processed without being
      // inserted (e.g. a duplicate title+platform within the CSV itself) —
      // `result.count` is the driver's actual affected-row count, so the
      // summary line reflects rows really written, not rows merely visited.
      if (result.count > 0) imported += 1;
      else skipped += 1;
    }

    console.log(`Imported ${imported} games (${skipped} rows skipped).`);
  } catch (error) {
    // Log the message only. An insert error can echo field values back, and
    // this table — like finance — holds the owner's personal data.
    console.error('Import failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  await main();
}
