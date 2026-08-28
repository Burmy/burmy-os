#!/usr/bin/env node
/**
 * Files existing library rows into collections — the one-off backfill that
 * makes `games.collection_id` mean something for a library imported before
 * the column existed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * The source spreadsheet drew a boxed set as one row with its games indented
 * underneath: "Uncharted: The Nathan Drake Collection" carried the price, the
 * hours and the trophy list, and the three remasters inside it were sparse
 * rows counted separately. `scripts/import-game-log.mjs` deliberately wrote
 * every one of those rows as an independent `games` row (see its own comment
 * about "sparse collection-stub rows") — the CSV export had already lost the
 * indentation, so the parent/child relationship was not recoverable at import
 * time. It has to be re-stated by hand, once, which is what this script is
 * for.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SAFETY: DRY RUN BY DEFAULT, AND EXACTLY ONE COLUMN IS EVER WRITTEN
 *
 * Same posture as backfill-game-metadata.mjs and sync-steam-library.mjs:
 *
 *   - No database write happens without the explicit `--apply` flag.
 *   - `collection_id` is the ONLY column this script writes. It does not
 *     clear a member's hours, move a price onto the collection, or adjust a
 *     status. Every one of those is a figure the owner typed, and a script
 *     that files rows into groups has no business editing them — differences
 *     are REPORTED so the owner can decide in the app.
 *   - A member that carries its own hours, price, platinum or achievement
 *     counts is reported and SKIPPED, not linked. Those figures belong to the
 *     collection under this model, so linking such a row would leave a number
 *     on screen that the UI labels "From the collection" while it is nothing
 *     of the sort. Clear it in the app first, then re-run.
 *   - The one-level rule is enforced here as well as in the app
 *     (`assertCollectionTargetValid` in src/server/db/games/games.ts): a
 *     collection cannot be filed into another collection, a row cannot be its
 *     own collection, and a row that already holds members cannot become a
 *     member itself. Duplicated deliberately — this script cannot import the
 *     DAL (see PLAIN ESM below) and an unenforced invariant in a backfill is
 *     how a two-level chain gets into a database that no view can render.
 *   - Against a NON-LOCAL database, `--apply` additionally requires
 *     `--remote`. This backfill genuinely has to run against production (that
 *     is where the real library lives), so it cannot carry the flat
 *     local-only guard the sync scripts use — but "I meant the production
 *     database" should be something you typed on purpose.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MAP IS THE INPUT, AND IT IS NOT GUESSED
 *
 * Which games are inside which boxed set is knowledge that lives in the
 * owner's head and in the original spreadsheet, not in the data — a title
 * alone cannot tell you whether "Uncharted 2: Among Thieves Remastered" was
 * bought inside the collection or separately. So this script takes an
 * explicit JSON map:
 *
 *   {
 *     "Uncharted: The Nathan Drake Collection": [
 *       "Uncharted: Drake's Fortune Remastered",
 *       "Uncharted 2: Among Thieves Remastered",
 *       "Uncharted 3: Drake's Deception Remastered"
 *     ]
 *   }
 *
 * Titles are matched case-insensitively with whitespace collapsed and
 * typographic quotes/dashes folded to ASCII, because a title copied out of a
 * spreadsheet routinely differs from the stored one in exactly those ways.
 * Anything that does not resolve to exactly one library row is reported and
 * skipped — never fuzzy-matched. Getting this wrong moves a game between two
 * visible rows, which is the same class of failure CLAUDE.md's merchant
 * normalization rule exists to prevent.
 *
 * `--suggest` writes a STARTING POINT for that file by looking for titles
 * that name themselves a collection and grouping other titles that share
 * their leading word. It is a keyword heuristic and it will be both wrong and
 * incomplete; it exists so the owner edits a file instead of typing one, and
 * it never touches the database.
 *
 * Usage:
 *   node --env-file-if-exists=.env scripts/link-game-collections.mjs <owner-email> --suggest [--out <path>]
 *   node --env-file-if-exists=.env scripts/link-game-collections.mjs <owner-email> --map <path> [--apply] [--remote]
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY PLAIN ESM
 *
 * Same reasoning as every other script in this directory: it needs only
 * `postgres` (already a production dependency) and Node's own JSON parsing.
 * It imports nothing from `src/` — the DAL reaches its modules through the
 * `@/` alias, which a bare `node` invocation cannot resolve without a bundler
 * or a tsconfig-paths loader.
 *
 * TESTABILITY
 *
 * The pure helpers below are `export`ed so
 * tests/unit/games-link-collections.test.ts can exercise them directly, the
 * same pattern games-sync-steam-library.test.ts already uses. The CLI body
 * lives in `main()`, invoked only when this file is run directly — importing
 * this module for its exports must never open a database connection or touch
 * `process.argv`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import postgres from 'postgres';

// Same set import-game-log.mjs, fix-game-platforms.mjs, backfill-game-metadata.mjs
// and sync-steam-library.mjs all use. Duplicated rather than imported — every
// script in this directory stays self-contained.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const DEFAULT_SUGGESTION_PATH = path.join(os.tmpdir(), 'burmy-collection-map.json');

/** Whether a Postgres connection string points at a local database. */
export function isLocalDatabaseUrl(url) {
  try {
    return LOCAL_HOSTNAMES.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function parseArgs(argv) {
  const args = argv.slice(2);
  let ownerEmail;
  let mapPath;
  let outPath;
  let suggest = false;
  let apply = false;
  let remote = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--suggest') {
      suggest = true;
    } else if (arg === '--apply') {
      apply = true;
    } else if (arg === '--remote') {
      remote = true;
    } else if (arg === '--map') {
      i += 1;
      mapPath = args[i];
    } else if (arg === '--out') {
      i += 1;
      outPath = args[i];
    } else if (ownerEmail === undefined) {
      ownerEmail = arg;
    }
  }

  return { ownerEmail, mapPath, outPath, suggest, apply, remote };
}

/**
 * The comparison key for a title.
 *
 * Folds case, collapses whitespace, and rewrites the characters a title
 * reliably picks up on its way through a spreadsheet and back: curly quotes
 * (Excel's autocorrect turns every apostrophe into U+2019) and en/em dashes.
 * Nothing else — this is a normalizer for TRANSCRIPTION noise, not a fuzzy
 * matcher. Two genuinely different titles must never collapse to one key.
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

/** True when a row carries figures the collection is supposed to own. */
export function carriesOwnFigures(row) {
  return (
    row.hoursTenths !== null ||
    row.priceCents !== null ||
    row.achievementsUnlocked !== null ||
    row.achievementsTotal !== null ||
    row.platinum === true
  );
}

/**
 * Turns the owner's map plus the current library into a list of writes and a
 * list of things a human has to look at. Pure — no database, no filesystem.
 *
 * `rows` is the whole library: `{ id, title, collectionId, status,
 * hoursTenths, priceCents, achievementsUnlocked, achievementsTotal,
 * platinum }`.
 *
 * Returns `{ links, alreadyLinked, problems, notes }`. Nothing is written for
 * a title that appears in `problems`: a partially-applied collection is
 * easier to see and finish than a wrong one is to undo.
 */
export function buildPlan(map, rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = titleKey(row.title);
    const bucket = byKey.get(key);
    if (bucket === undefined) byKey.set(key, [row]);
    else bucket.push(row);
  }

  // Which rows currently hold members, so a row that is already a collection
  // is never itself filed into one.
  const holdsMembers = new Set(rows.filter((r) => r.collectionId !== null).map((r) => r.collectionId));

  const links = [];
  const alreadyLinked = [];
  const problems = [];
  const notes = [];

  function resolve(title, role) {
    const matches = byKey.get(titleKey(title)) ?? [];
    if (matches.length === 1) return matches[0];
    problems.push(
      matches.length === 0
        ? `${role} "${title}": no library row with that title.`
        : `${role} "${title}": ${matches.length} library rows share that title — resolve the duplicate first.`,
    );
    return null;
  }

  for (const [collectionTitle, memberTitles] of Object.entries(map)) {
    const collection = resolve(collectionTitle, 'Collection');
    if (collection === null) continue;

    if (collection.collectionId !== null) {
      problems.push(
        `Collection "${collectionTitle}" is itself inside another collection. A collection cannot be nested — take it out first.`,
      );
      continue;
    }

    for (const memberTitle of memberTitles) {
      const member = resolve(memberTitle, 'Title');
      if (member === null) continue;

      if (member.id === collection.id) {
        problems.push(`Title "${memberTitle}" is listed inside itself.`);
        continue;
      }
      if (holdsMembers.has(member.id)) {
        problems.push(
          `Title "${memberTitle}" already holds games of its own, so it cannot go inside "${collectionTitle}".`,
        );
        continue;
      }
      if (member.collectionId === collection.id) {
        alreadyLinked.push(`${memberTitle} → ${collectionTitle}`);
        continue;
      }
      if (member.collectionId !== null) {
        problems.push(
          `Title "${memberTitle}" is already in a different collection. Move it in the app if that is wrong.`,
        );
        continue;
      }
      if (carriesOwnFigures(member)) {
        problems.push(
          `Title "${memberTitle}" carries its own hours/price/trophies. Under this model those belong to "${collectionTitle}" — clear them in the app, then re-run.`,
        );
        continue;
      }

      if (member.status !== collection.status) {
        notes.push(
          `"${memberTitle}" is ${member.status} while "${collectionTitle}" is ${collection.status}. This script does not change a status; set it in the app if it should match.`,
        );
      }

      links.push({
        gameId: member.id,
        collectionId: collection.id,
        memberTitle: member.title,
        collectionTitle: collection.title,
      });
    }
  }

  return { links, alreadyLinked, problems, notes };
}

const COLLECTION_WORDS =
  /\b(collection|trilogy|anthology|compilation|duology|bundle|remastered\s+collection)\b/i;

/** Words too common to identify a series. */
const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'my', 'new', 'super', 'ultra']);

function leadWord(title) {
  for (const word of titleKey(title).split(/[^a-z0-9]+/)) {
    if (word.length > 2 && !STOP_WORDS.has(word)) return word;
  }
  return null;
}

/**
 * A STARTING POINT for the map file, not an answer.
 *
 * Rows whose title names them a collection become keys; every other row
 * sharing their leading word becomes a candidate value. It will over-group
 * (a series' standalone entries look identical to its collected ones) and
 * under-group (a boxed set that does not say "Collection" anywhere is
 * invisible to this). Both are fine: the owner edits the file, and the map is
 * what gets applied.
 */
export function suggestMap(rows) {
  const candidates = rows.filter((row) => COLLECTION_WORDS.test(row.title));
  const candidateIds = new Set(candidates.map((row) => row.id));
  const entries = [];

  for (const candidate of candidates) {
    const lead = leadWord(candidate.title);
    if (lead === null) continue;
    entries.push([
      candidate.title,
      rows
        .filter((row) => !candidateIds.has(row.id) && leadWord(row.title) === lead)
        .map((row) => row.title)
        .sort(),
    ]);
  }

  return Object.fromEntries(entries);
}

async function main() {
  const { ownerEmail, mapPath, outPath, suggest, apply, remote } = parseArgs(process.argv);

  if (!ownerEmail || (!suggest && mapPath === undefined)) {
    console.error('Usage:');
    console.error('  node scripts/link-game-collections.mjs <owner-email> --suggest [--out <path>]');
    console.error('  node scripts/link-game-collections.mjs <owner-email> --map <path> [--apply] [--remote]');
    console.error('');
    console.error('Defaults to a DRY RUN. Pass --apply to write `collection_id`; nothing else is ever written.');
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  if (apply && !isLocalDatabaseUrl(databaseUrl) && !remote) {
    console.error('DATABASE_URL is not local and --apply was passed without --remote.');
    console.error('Add --remote if you really mean to file the production library into collections.');
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

    const dbRows = await sql`
      select id, title, collection_id, status, hours_tenths, price_cents,
             achievements_unlocked, achievements_total, platinum
      from games
      where owner_id = ${owner.id}
      order by title
    `;
    const rows = dbRows.map((row) => ({
      id: row.id,
      title: row.title,
      collectionId: row.collection_id,
      status: row.status,
      hoursTenths: row.hours_tenths,
      priceCents: row.price_cents,
      achievementsUnlocked: row.achievements_unlocked,
      achievementsTotal: row.achievements_total,
      platinum: row.platinum,
    }));

    if (rows.length === 0) {
      console.log(`No games found for ${email}.`);
      return;
    }

    if (suggest) {
      const target = outPath ?? DEFAULT_SUGGESTION_PATH;
      const suggestion = suggestMap(rows);
      await writeFile(target, `${JSON.stringify(suggestion, null, 2)}\n`, 'utf8');
      console.log(`Wrote ${Object.keys(suggestion).length} candidate collection(s) to ${target}.`);
      console.log('Edit it — this is a keyword guess, not an answer — then re-run with --map <path>.');
      return;
    }

    let map;
    try {
      map = JSON.parse(await readFile(mapPath, 'utf8'));
    } catch (error) {
      console.error(`Could not read ${mapPath}: ${error instanceof Error ? error.message : 'unknown error'}`);
      process.exitCode = 1;
      return;
    }

    const { links, alreadyLinked, problems, notes } = buildPlan(map, rows);

    for (const line of notes) console.log(`note: ${line}`);
    for (const line of problems) console.error(`skipped: ${line}`);
    if (alreadyLinked.length > 0) console.log(`Already filed: ${alreadyLinked.length}`);

    if (links.length === 0) {
      console.log('Nothing to link.');
      if (problems.length > 0) process.exitCode = 1;
      return;
    }

    for (const link of links) {
      console.log(`${apply ? 'link' : 'would link'}: ${link.memberTitle} → ${link.collectionTitle}`);
    }

    if (!apply) {
      console.log(`\nDry run — ${links.length} row(s) would be filed. Re-run with --apply to write.`);
      if (problems.length > 0) process.exitCode = 1;
      return;
    }

    // One statement per row rather than a bulk update: at this size (tens of
    // rows, once) the round trips cost nothing, and a per-row write keeps the
    // failure mode legible — the console line above each one says exactly
    // what was attempted.
    for (const link of links) {
      await sql`
        update games
        set collection_id = ${link.collectionId}, updated_at = now()
        where id = ${link.gameId} and owner_id = ${owner.id}
      `;
    }

    console.log(`\nFiled ${links.length} row(s) into collections.`);
    if (problems.length > 0) process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  await main();
}
