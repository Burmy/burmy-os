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
 *
 * SHAPE OF THE REAL EXPORT
 *
 * This script was rewritten once already, against the owner's actual "Game
 * log" export rather than an assumed CSV shape. Every quirk below is real,
 * confirmed against that file — see
 * .superpowers/sdd/2026-08-20-game-tracker/real-csv-analysis.md for the full
 * analysis. In short: the sheet's own first column is a blank spacer, so
 * every field a naive reader would expect is one position further right;
 * columns are therefore resolved BY HEADER NAME, never a fixed offset. One
 * row is missing that spacer entirely. One title spans two physical lines
 * inside a quoted field. Ratings are 5-glyph star strings, not integers. And
 * the sheet has no Platform column at all — the owner decided platform by
 * SECTION of the sheet instead (see `guessPlatform` below).
 *
 * OPTIONAL PLATFORM MAP (third CLI argument)
 *
 * `guessPlatform`'s section-position guess turned out to be wrong for the
 * ps4/ps5 split (it collapsed every modern PlayStation title into `ps5`,
 * with no split at all) — because the CSV export cannot carry the sheet's
 * REAL platform signal, the row's cell background colour, which is destroyed
 * on export same as everything else colour-coded in the sheet. The owner
 * recovered a confirmed title->platform map from the sheet's `.xlsx` export
 * separately (see scripts/fix-game-platforms.mjs, which applies that same
 * map to rows already imported). This script accepts that map as an
 * OPTIONAL third argument so a future re-import doesn't have to repeat the
 * same correction after the fact: a title present in the map wins outright;
 * a title absent from it falls back to `guessPlatform`'s section logic
 * exactly as before. Omit the argument and behaviour is unchanged. See
 * `resolvePlatform` below.
 */

import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';

// Same set src/server/db/seed-guard.ts uses for the identical `db:seed`
// local-only guard. Duplicated rather than imported: that module is
// TypeScript, and this script stays plain ESM on purpose (see house-style
// note above) — importing a .ts file from a .mjs script would need a loader
// this script deliberately has no reason to carry.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** The sheet's named data columns, in the order `games` wants to read them. */
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

/**
 * Header rows are detected by which columns are PRESENT, not by any fixed
 * position — a coincidental single-column match (e.g. some other row that
 * happens to contain the literal text "Rating") shouldn't false-positive, so
 * all three of these must appear together.
 */
const REQUIRED_HEADER_COLUMNS = ['Title', 'Hours', 'Rating'];

const FILLED_STAR = '★'; // U+2605
const EMPTY_STAR = '☆'; // U+2606
const STAR_RATING_RE = new RegExp(`^[${FILLED_STAR}${EMPTY_STAR}]+$`);

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

/**
 * Splits raw CSV text into logical RECORDS, honouring a quoted field that
 * embeds a literal newline — one real title in the source sheet ("Slay the
 * Spire 2") is a single logical row split across two physical lines this
 * way. A naive `raw.split(/\r?\n/)` treats that embedded newline as a record
 * boundary and corrupts both halves of the row: the first fragment has a
 * title but no other fields, and the second fragment's stray unterminated
 * quote swallows every comma in it into one field. See real-csv-analysis.md,
 * Mismatch #5.
 *
 * Quote state is tracked by toggling on every `"` encountered, including
 * within a doubled `""` escape — two toggles in a row net back to the
 * original state, so this stays correct for escaped quotes without needing
 * to special-case them (unlike `splitCsvLine`, which has to, because it also
 * has to UNESCAPE the content; this function only needs to know whether a
 * newline is currently inside a quoted field, not what the field says).
 */
export function splitCsvRecords(raw) {
  const records = [];
  let current = '';
  let inQuotes = false;

  const pushRecord = () => {
    records.push(current.endsWith('\r') ? current.slice(0, -1) : current);
  };

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
    } else if (char === '\n' && !inQuotes) {
      pushRecord();
      current = '';
    } else {
      current += char;
    }
  }
  pushRecord();

  return records;
}

/**
 * Locates the header row by its FIELDS, not by where the line starts. The
 * real export's header begins with a leading empty column before "Title"
 * (`,Title,Publisher,...`), so a regex anchored on the start of the line —
 * the original approach — never matches a single line in the file. See
 * real-csv-analysis.md, Mismatch #1.
 */
export function findHeaderRowIndex(records) {
  return records.findIndex((record) => {
    const fields = splitCsvLine(record);
    return REQUIRED_HEADER_COLUMNS.every((column) => fields.includes(column));
  });
}

/**
 * Resolves each of `DATA_COLUMNS` to its field index in the header row. The
 * real export shifts every column one place right of what a naive
 * fixed-offset destructure expects (a blank spacer column before Title) —
 * see Mismatch #2 — so every row has to be read BY COLUMN NAME, resolved
 * once here, never a hardcoded offset. A column not found in the header
 * comes back as `-1`; the caller decides whether that's fatal.
 */
/**
 * @param {string[]} headerFields
 * @returns {Record<string, number>}
 */
export function buildColumnIndex(headerFields) {
  const index = {};
  for (const column of DATA_COLUMNS) {
    index[column] = headerFields.indexOf(column);
  }
  return index;
}

/**
 * Realigns a data row that is missing its leading spacer column. Every other
 * row in the real export — game data, decorative, and trailing summary rows
 * alike — begins with an empty first field; exactly one game row does not
 * (its own leading comma was dropped during export), which shifts every one
 * of ITS fields one position left of what `buildColumnIndex` expects. That
 * broken invariant (field 0 unexpectedly non-empty) is what's detected here
 * — generically, not by matching the specific title string that happens to
 * be affected in the real file. See real-csv-analysis.md, Mismatch #4.
 *
 * The fused field isn't pure title text: this row's own spacer-column value
 * was the sheet's own "-" ("not tracked") placeholder, glued directly onto
 * the Title text with no comma between them (`-Uncharted: Legacy of...`).
 * Recovering the real title means splitting off exactly that leading "-",
 * not just prepending a blank — the sheet's own placeholder convention
 * decides where the boundary falls, not anything specific to this title.
 * Any other missing-comma row that DOESN'T start with "-" (none exist in
 * the real file, but the field-0-non-empty signature alone doesn't
 * guarantee one) still gets realigned safely: its whole fused field becomes
 * the Title as-is, same as before.
 */
export function realignRowFields(fields) {
  if (fields[0] === '') return fields;
  const [spacer, title] = fields[0].startsWith('-') ? ['-', fields[0].slice(1)] : ['', fields[0]];
  return [spacer, title, ...fields.slice(1)];
}

/**
 * "53 + 6" -> 590 tenths. "-" / "" / whitespace-only -> null, never 0 —
 * unknown is not zero. Trims BEFORE the empty/dash check: an untrimmed ""
 * from `''.trim()` still satisfies `Number.isFinite(Number(''))` (0 is
 * finite), so without trimming first, "   " would silently sum to 0 instead
 * of returning null. `splitCsvLine` already trims every field in the shipped
 * pipeline, so this only self-guards a caller that hands raw, untrimmed text
 * straight to the exported function — which is exactly what a standalone
 * unit test does.
 */
export function parseHoursTenths(raw) {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === '-') return null;
  const parts = trimmed
    .split('+')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n));
  if (parts.length === 0) return null;
  return Math.round(parts.reduce((sum, n) => sum + n, 0) * 10);
}

/**
 * "2024 + 2025" -> 2024 (when it was STARTED, the first component).
 * "-" / "" / whitespace-only -> null. Trimmed first for the same reason as
 * `parseHoursTenths` — without it, "   " parses as `Number('') === 0`, which
 * only failed to leak through here by accident, because 0 happens to fail
 * the `> 1970` range check below. That's not a guarantee worth relying on.
 */
export function parseFirstYear(raw) {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === '-') return null;
  const first = Number(trimmed.split('+')[0]?.trim());
  return Number.isInteger(first) && first > 1970 && first < 2100 ? first : null;
}

/**
 * Plain or composite ("+"-summed) integer field. "-" / "" / whitespace-only
 * -> null, never 0. Trimmed first — see `parseHoursTenths`.
 */
export function parseInteger(raw) {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === '-') return null;
  const parts = trimmed
    .split('+')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n));
  if (parts.length === 0) return null;
  return Math.round(parts.reduce((sum, n) => sum + n, 0));
}

/**
 * "$49.99 +29.99" -> 7998 cents. "-" / "" / whitespace-only -> null, never 0.
 * Trimmed first — see `parseHoursTenths`.
 */
export function parsePriceCents(raw) {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === '-') return null;
  const parts = trimmed
    .replace(/\$/g, '')
    .split('+')
    .map((p) => Number(p.trim()))
    .filter((n) => Number.isFinite(n));
  if (parts.length === 0) return null;
  return Math.round(parts.reduce((sum, n) => sum + n, 0) * 100);
}

/**
 * The Rating column holds 5-glyph star strings (`★★★★☆` = 4 filled, 1
 * empty), not integers — `Number('★★★★☆')` is `NaN`, so the original
 * `parseInteger` silently nulled every real rating in the file. See
 * real-csv-analysis.md, Mismatch #3.
 *
 * Accepts exactly two shapes: a run of star glyphs (counts the FILLED ones,
 * `★`; `☆` is a deliberate empty slot, not a character to count), or a bare
 * digit string (a handful of the sheet's own rows, and any future manual
 * entry, could plausibly use a plain number instead of stars). "-" / "" /
 * whitespace-only -> null. Anything else -> null too, rather than silently
 * miscounting: a garbage string that happens to contain zero `★` characters
 * must not be reported as "rated zero stars".
 */
export function parseStarRating(raw) {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === '-') return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (STAR_RATING_RE.test(trimmed)) {
    return [...trimmed].filter((char) => char === FILLED_STAR).length;
  }
  return null;
}

/**
 * Whether a row reads as `'completed'` or `'backlog'`.
 *
 * `hoursTenths === null` alone is NOT "never started" — every pre-2015 retro
 * row has null hours by definition (the sheet records every field but Title
 * and Rating as "-" for that whole block), and using hours-null as the sole
 * signal would mislabel the owner's entire retro library as backlog on the
 * first real import. A 1-5 rating is only meaningful for a game that was
 * actually played, so hours OR a stored rating is treated as evidence of
 * having played it. This is an inference, not a certainty — a game played
 * but not finished still reads as `'completed'`, and a row with neither
 * hours nor a rating (a genuine unplayed backlog entry, which the real sheet
 * also has) correctly stays `'backlog'`. The owner can correct individual
 * rows in the UI after import. `ratingValue` must be the CLAMPED value that
 * will actually be stored (1-5 or null) — an out-of-range rating that gets
 * nulled for storage should not count as evidence either.
 */
export function deriveStatus(hoursTenths, ratingValue) {
  return hoursTenths !== null || ratingValue !== null ? 'completed' : 'backlog';
}

/**
 * The source sheet has no Platform column at all, and no in-title platform
 * hint either (verified: 0 of 161 real titles contain one) — so platform
 * assignment can't come from parsing anything about an individual row in
 * isolation. What the sheet DOES encode, structurally, is three contiguous
 * SECTIONS, confirmed by the sheet's own summary rows (separate PS5/PS4, PSP
 * and Steam/PC totals): a block of modern PlayStation titles, then a block
 * of retro titles (every field but Title and Rating recorded as "-", since
 * hours/ownership/year/trophies were never tracked for them), then a block
 * of native Steam/PC titles. The owner's explicit decision, given that
 * shape: every modern PlayStation game is `'ps5'` (no PS4/PS5 split by
 * year — a year carries zero platform information), the retro block is
 * `'psp'`, and everything after it is `'steam'`. See real-csv-analysis.md.
 *
 * This has to be STATEFUL across rows (which section are we in right now?),
 * so it's a factory: call it once per import to get a per-row assigner
 * function, then feed it each row's Ownership/Hours/First Played/Trophies
 * text IN FILE ORDER. The retro block itself is detected by its own
 * signature — all four of those fields reading "-" — not by row number or
 * year, and once that signature is seen and then left behind, every
 * subsequent row is `'steam'` for the rest of the file (confirmed: the
 * all-dash signature is unique to the one contiguous retro block; later
 * rows with an untracked Ownership still carry a real Hours or Trophies
 * value, so they never match all four).
 */
export function guessPlatform() {
  // A strictly ONE-WAY walk through the three sections — ps5 -> psp ->
  // steam — never back. Once a non-retro row is seen after the retro
  // block, every later row is 'steam' even if it happens to match the
  // all-dash signature again (a real, if unlikely, possibility: the sheet
  // itself notes a handful of untracked Steam titles also carry "-" values
  // for individual fields). The sheet has exactly one contiguous retro
  // block, not a repeatable pattern — modelling it as three ordered
  // sections, rather than "classify every all-dash row as psp wherever it
  // appears," is the more defensive reading of the owner's rule.
  let stage = 'ps5';

  return (ownershipText, hoursText, firstPlayedText, trophiesText) => {
    if (stage === 'steam') return 'steam';

    const isRetroRow =
      ownershipText === '-' && hoursText === '-' && firstPlayedText === '-' && trophiesText === '-';

    if (isRetroRow) {
      stage = 'psp';
      return 'psp';
    }

    if (stage === 'psp') {
      stage = 'steam';
      return 'steam';
    }

    return 'ps5';
  };
}

/**
 * Collapses whitespace runs and trims the ends. The recovered platform map
 * (see scripts/fix-game-platforms.mjs, which defines the identical helper
 * for the same reason) is generated separately from the CSV and can carry
 * stray spacing — e.g. a trailing-space title — that the CSV's own title
 * text does not; comparing the two without this would under-match real,
 * correct pairs for a reason that has nothing to do with the games being
 * different. Duplicated rather than imported: see the note above
 * `LOCAL_HOSTNAMES` on why every script here stays self-contained.
 */
export function normalizeTitle(title) {
  return title.trim().replace(/\s+/g, ' ');
}

/**
 * Resolves one row's final platform: a matching entry in the recovered
 * platform map wins outright, because it is CONFIRMED data (recovered from
 * the sheet's own colour legend); `guessedPlatform` — the section-walk's own
 * answer for this row, from `guessPlatform` — is only a fallback for a title
 * the map doesn't cover. `platformMap` is optional; when it's `null` (the
 * argument was never supplied), this always returns `guessedPlatform`,
 * i.e. behaviour identical to before this map existed.
 *
 * Takes the already-resolved `guessedPlatform` rather than calling
 * `guessPlatform`'s assigner itself, because that assigner is STATEFUL and
 * must observe every row in file order to track which section it's in — the
 * caller runs it unconditionally, for every row, whether or not the map ends
 * up overriding its answer, so the section walk never desyncs.
 */
export function resolvePlatform(platformMap, title, guessedPlatform) {
  if (!platformMap) return guessedPlatform;

  const normalized = normalizeTitle(title);
  for (const [mapTitle, platform] of Object.entries(platformMap)) {
    if (normalizeTitle(mapTitle) === normalized) return platform;
  }
  return guessedPlatform;
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
  const [, , csvPath, ownerEmail, platformMapPath] = process.argv;

  if (!csvPath || !ownerEmail) {
    console.error(
      'Usage: node scripts/import-game-log.mjs <path-to-csv> <owner-email> [path-to-platform-map.json]',
    );
    console.error(
      'The optional third argument overrides guessPlatform\'s section-position guess with confirmed data ' +
        'recovered from the sheet\'s .xlsx export — see the header comment for why the CSV alone cannot carry it.',
    );
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

    /** @type {Record<string, string> | null} */
    const platformMap = platformMapPath ? JSON.parse(await readFile(platformMapPath, 'utf8')) : null;

    const raw = await readFile(csvPath, 'utf8');
    const records = splitCsvRecords(raw).filter((record) => record.trim() !== '');
    const headerIndex = findHeaderRowIndex(records);
    if (headerIndex === -1) {
      console.error(
        'Could not find the header row (expected a row whose fields include "Title", "Hours", and "Rating").',
      );
      process.exitCode = 1;
      return;
    }

    const headerFields = splitCsvLine(records[headerIndex]);
    const columnIndex = buildColumnIndex(headerFields);
    const missingColumns = DATA_COLUMNS.filter((column) => columnIndex[column] === -1);
    if (missingColumns.length > 0) {
      console.error(`Header row is missing expected column(s): ${missingColumns.join(', ')}.`);
      process.exitCode = 1;
      return;
    }

    const assignPlatform = guessPlatform();
    let imported = 0;
    let skipped = 0;

    for (const record of records.slice(headerIndex + 1)) {
      const fields = realignRowFields(splitCsvLine(record));

      const title = fields[columnIndex.Title] ?? '';
      // Trailing summary/total rows (game count, per-platform cost totals,
      // etc.) all have an empty Title field, and are the only rows that do
      // — every real game row, including every sparse collection-stub row,
      // has a title. The first empty-Title row therefore marks the end of
      // real data; everything from here on is a footer, not a game.
      if (!title) break;
      if (title === '-') {
        skipped += 1;
        continue;
      }

      const publisher = fields[columnIndex.Publisher] ?? '';
      const developer = fields[columnIndex.Developer] ?? '';
      const ownershipText = fields[columnIndex.Ownership] ?? '';
      const priceText = fields[columnIndex.Price] ?? '';
      const hoursText = fields[columnIndex.Hours] ?? '';
      const yearText = fields[columnIndex['First Played']] ?? '';
      const trophiesText = fields[columnIndex.Trophies] ?? '';
      const ratingText = fields[columnIndex.Rating] ?? '';

      const firstPlayedYear = parseFirstYear(yearText);
      const hoursTenths = parseHoursTenths(hoursText);
      const parsedRating = parseStarRating(ratingText);
      const ratingValue = parsedRating !== null && parsedRating >= 1 && parsedRating <= 5 ? parsedRating : null;
      // Always run the section-walk assigner, whether or not the platform
      // map ends up overriding its answer for THIS row — it is stateful and
      // must observe every row in file order or later rows' section
      // boundaries desync. See `resolvePlatform`'s own doc comment.
      const guessedPlatform = assignPlatform(ownershipText, hoursText, yearText, trophiesText);
      const platform = resolvePlatform(platformMap, title, guessedPlatform);

      const result = await sql`
        insert into games (
          owner_id, title, platform, developer, publisher, ownership, price_cents,
          status, rating, hours_tenths, first_played_year, achievements_unlocked, notes
        ) values (
          ${owner.id}, ${title}, ${platform},
          ${developer && developer !== '-' ? developer : null},
          ${publisher && publisher !== '-' ? publisher : null},
          ${/^physical$/i.test(ownershipText) ? 'physical' : /^digital$/i.test(ownershipText) ? 'digital' : null},
          ${parsePriceCents(priceText)},
          ${deriveStatus(hoursTenths, ratingValue)},
          ${ratingValue},
          ${hoursTenths},
          ${firstPlayedYear},
          ${parseInteger(trophiesText)},
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
