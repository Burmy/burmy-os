#!/usr/bin/env node
/**
 * One-off promotion of three games' notes-only year splits into real
 * `game_play_years` rows.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * The original spreadsheet import (import-game-log.mjs) recorded a handful of
 * games whose hours spanned a year boundary as a composite string ("53 + 6")
 * because the sheet had no per-year columns at all. That string survived only
 * as prose in `games.notes` — e.g. Clair Obscur: Expedition 33's notes read
 * "Imported as \"53 + 6\" across 2025 + 2026" — never as structured data. Now
 * that `game_play_years` (see src/server/games/play-years.ts and
 * src/server/db/games/play-years.ts) can attribute a game's hours to the
 * years actually played, this script promotes those three recovered splits
 * from prose into real rows, which is what finally moves the misattributed
 * hours into the right years on /games/stats.
 *
 * This is a script rather than a SQL data migration because migrations run
 * against both local and production, where `games.id` values differ, and a
 * title-keyed `UPDATE`/`INSERT` inside a migration is fragile — same
 * reasoning fix-game-platforms.mjs's header gives for staying a script.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SAFETY: DRY RUN BY DEFAULT, AND EVERY SPLIT IS RE-VERIFIED BEFORE WRITING
 *
 * The three splits below were recovered by hand and verified against the
 * live database once, but "once" is not a standing guarantee — a game's
 * `hours_tenths` could change before this ever runs. So for every entry this
 * script: looks up the game by exact title, sums the split, and compares
 * that sum against the game's CURRENT `hours_tenths`. Any mismatch (or a
 * missing/ambiguous title) is reported loudly and that game is skipped
 * entirely — this script never writes a split that does not add up, and it
 * never guesses which game a title "probably" means.
 *
 * `--apply` is required to write anything. Without it, the script only
 * reports what it WOULD do. The write itself is additive and reversible:
 * `games.hours_tenths` is never touched, only `game_play_years` rows are
 * inserted, and re-running with `--apply` is a safe no-op (delete-then-insert
 * per game inside a transaction, same pattern as `replacePlayYears` in
 * src/server/db/games/play-years.ts) — a game that already has the identical
 * split (e.g. Hollow Knight, hand-entered once already through the UI) just
 * gets its two rows deleted and re-inserted with the same values.
 *
 * Usage:
 *   node --env-file-if-exists=.env scripts/seed-play-year-splits.mjs <owner-email> [--apply]
 *
 * Defaults to a DRY RUN. Pass --apply to write.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY PLAIN ESM AND NOT TYPESCRIPT
 *
 * Same reasoning as scripts/migrate.mjs and every other one-off script in
 * this directory: this only needs `postgres`, already a production
 * dependency, to read a few rows and write a few rows.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

import postgres from 'postgres';

// Same set fix-game-platforms.mjs, backfill-game-metadata.mjs,
// import-game-log.mjs and src/server/db/seed-guard.ts all use for the
// identical local-only guard. Duplicated rather than imported — every
// script in this directory is deliberately self-contained.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * The three games whose sheet entry recorded hours as a composite string
 * ("53 + 6") because it spanned a year boundary. The import preserved that
 * only as prose in `notes`; this promotes it to real per-year rows.
 *
 * Each split is asserted against the game's stored total before writing — if
 * a total has changed since these were recorded, the script refuses that game
 * rather than writing a split that does not add up.
 */
const SPLITS = [
  { title: 'Clair Obscur: Expedition 33', years: [[2025, 530], [2026, 60]] },
  { title: 'Hollow Knight', years: [[2024, 370], [2025, 120]] },
  { title: 'Lies of P', years: [[2024, 520], [2025, 250]] },
];

/**
 * Whether a Postgres connection string points at a local database. Identical
 * logic to fix-game-platforms.mjs's and backfill-game-metadata.mjs's own
 * `isLocalDatabaseUrl` — see either for why `[::1]` needs to be in the
 * allowlist as a literal bracketed string, and why unparsable input fails
 * closed.
 */
export function isLocalDatabaseUrl(url) {
  try {
    return LOCAL_HOSTNAMES.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Parses this script's CLI: one required positional (owner email) and an
 * optional `--apply` flag. Pure and exported, same shape as
 * backfill-game-metadata.mjs's own `parseArgs`.
 */
export function parseArgs(argv) {
  const args = argv.slice(2);
  let ownerEmail;
  let apply = false;

  for (const arg of args) {
    if (arg === '--apply') {
      apply = true;
    } else if (ownerEmail === undefined) {
      ownerEmail = arg;
    }
  }

  return { ownerEmail, apply };
}

/**
 * Sums a split's tenths. Plain integer addition — hours are stored and
 * summed as whole tenths everywhere in this app (src/server/games/hours.ts),
 * never as a float, so there is nothing here for a `Cents`-style wrapper to
 * protect against.
 */
export function sumSplitTenths(years) {
  return years.reduce((total, [, tenths]) => total + tenths, 0);
}

/** `530` -> `"53.0h"`. Display only — never used for arithmetic. */
export function formatTenths(tenths) {
  return `${(tenths / 10).toFixed(1)}h`;
}

async function main() {
  const { ownerEmail, apply } = parseArgs(process.argv);

  if (!ownerEmail) {
    console.error('Usage: node scripts/seed-play-year-splits.mjs <owner-email> [--apply]');
    console.error('Defaults to a DRY RUN. Pass --apply to write the splits to the database.');
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  if (!isLocalDatabaseUrl(databaseUrl)) {
    console.error('Refusing to run against a non-local database. Seed locally, then migrate deliberately.');
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

    console.log(`${apply ? 'APPLY' : 'DRY RUN'}: seeding ${SPLITS.length} known play-year split(s) for ${email}.`);
    console.log('');

    let matched = 0;
    let skipped = 0;

    for (const split of SPLITS) {
      const rows = await sql`
        select id, hours_tenths
        from games
        where owner_id = ${owner.id} and title = ${split.title}
      `;

      if (rows.length === 0) {
        skipped += 1;
        console.error(`[SKIP] "${split.title}": no matching game for this owner.`);
        continue;
      }

      if (rows.length > 1) {
        skipped += 1;
        console.error(`[SKIP] "${split.title}": ${rows.length} games match this exact title — ambiguous, refusing to guess.`);
        continue;
      }

      const [game] = rows;
      const splitSum = sumSplitTenths(split.years);

      if (game.hours_tenths === null) {
        skipped += 1;
        console.error(`[SKIP] "${split.title}": stored hours_tenths is null, split sums to ${formatTenths(splitSum)} — no total to check against.`);
        continue;
      }

      if (game.hours_tenths !== splitSum) {
        skipped += 1;
        console.error(
          `[SKIP] "${split.title}": stored ${formatTenths(game.hours_tenths)} does not match split sum ${formatTenths(splitSum)} — the data moved since this split was recorded. A human needs to look.`,
        );
        continue;
      }

      matched += 1;
      const breakdown = split.years.map(([year, tenths]) => `${year}: ${formatTenths(tenths)}`).join(', ');
      console.log(`[OK] "${split.title}": stored ${formatTenths(game.hours_tenths)} = split (${breakdown}).`);

      if (apply) {
        await sql.begin(async (tx) => {
          await tx`delete from game_play_years where owner_id = ${owner.id} and game_id = ${game.id}`;
          for (const [year, tenths] of split.years) {
            await tx`
              insert into game_play_years (owner_id, game_id, year, hours_tenths)
              values (${owner.id}, ${game.id}, ${year}, ${tenths})
            `;
          }
        });
        console.log(`      ${split.years.length} row(s) written.`);
      }
    }

    console.log('');
    console.log(`Matched ${matched}/${SPLITS.length} split(s), ${skipped} skipped.`);
    console.log(
      apply
        ? `Applied ${matched} split(s) to the database.`
        : 'DRY RUN — no database writes were made. Review the output above, then re-run with --apply if it looks right.',
    );
  } catch (error) {
    // Log the message only. This table holds the owner's personal game
    // library, same privacy posture as Finance and the other games scripts.
    console.error('Seeding failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  await main();
}
