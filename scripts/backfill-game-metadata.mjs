#!/usr/bin/env node
/**
 * One-off backfill of IGDB cover art/genre/metacritic/playtime/ESRB for the
 * 160 games already imported by scripts/import-game-log.mjs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * The historical import (import-game-log.mjs) only ever wrote the columns the
 * owner's spreadsheet actually carried — title, platform, developer,
 * publisher, ownership, price, status, rating, hours, first-played year,
 * achievements. `cover_url`, `genre`, `metacritic`, `average_playtime_hours`
 * and `esrb_rating` are IGDB-sourced enrichments (see
 * src/server/games/metadata.ts and src/server/db/games/igdb.ts, added when
 * the app switched from RAWG to IGDB) that were never fetched for games
 * imported before that integration existed. This script closes that gap for
 * the whole existing library in one run, the same way fix-game-platforms.mjs
 * closed a different one-off gap for `platform`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SAFETY: DRY RUN BY DEFAULT — THIS IS THE MOST IMPORTANT THING ABOUT THIS FILE
 *
 * Matching a locally-typed title against a third-party catalog is genuinely
 * error-prone: an HD remaster can match a PSP original, a numbered sequel can
 * match its predecessor, a demo or a soundtrack listing can outrank the real
 * game. Writing a wrong cover/genre/metacritic/playtime/ESRB value is a
 * quieter, harder-to-notice mistake than a wrong platform or a wrong price,
 * because nothing about the app's own data flags it as wrong afterward.
 *
 * So: this script NEVER writes to the database unless invoked with the
 * explicit `--apply` flag, and even then it only ever applies a HIGH
 * confidence match (see `scoreTitleMatch` in src/server/games/metadata.ts for
 * the exact policy — identical after normalization, a known abbreviation
 * collapse, or a guarded token-containment match; never a fuzzy guess). Every
 * LOW confidence match and every "no match found" is written to the report
 * for the owner to read and decide on by hand; the script never guesses on
 * their behalf.
 *
 * Every write is additionally guarded with `coalesce(column, $new)` at the
 * SQL level (see `applyFill` below) as defense-in-depth on top of the
 * already-null-checked `metadataFieldsToFill` — a column already holding a
 * value, owner-supplied or previously backfilled, is never overwritten, even
 * across a re-run.
 *
 * Usage:
 *   node --env-file-if-exists=.env scripts/backfill-game-metadata.mjs <owner-email> [--apply] [--report <path>]
 *
 * `--report <path>` overrides the report location (default: a fixed path
 * under the OS temp directory, deliberately OUTSIDE this repo — this report
 * describes the owner's real personal game library and must never be
 * committed, same rule CLAUDE.md holds Finance fixtures to).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY PLAIN ESM, AND WHY THIS ONE IMPORTS FROM src/ WHERE THE OTHER SCRIPTS DON'T
 *
 * Same reasoning as import-game-log.mjs and fix-game-platforms.mjs for staying
 * plain ESM: this only needs `postgres` (already a production dependency) and
 * `fetch` (built into Node 24), so no tsx -> esbuild -> native-binary chain.
 *
 * Unlike those two scripts, this one DOES import from src/ —
 * `../src/server/games/metadata.ts` — rather than duplicating that logic
 * inline. Two things make that safe here where it wasn't worth doing there:
 * (1) Node 24 natively type-strips a plain, alias-free `.ts` file with no
 * build step (verified directly: `node` resolves a relative `.ts` import with
 * only erasable syntax — interfaces, type annotations — with zero
 * configuration); metadata.ts qualifies because it has NO imports of its own,
 * so there's no `@/...` path-alias resolution for a bare `node` invocation to
 * fail on. (2) The alternative — hand-duplicating the Apicalypse query
 * builders, IGDB response shaping, and the title-scoring policy (the part
 * that has to be right to avoid a wrong cover/genre silently landing in the
 * database) — is exactly the kind of duplication CLAUDE.md's dedupe_key
 * gotcha warns about: a second, drifting copy of logic that MUST stay
 * identical to the tested original. `src/server/db/games/igdb.ts`, by
 * contrast, imports `@/server/games/metadata` (the alias) and therefore can't
 * be `node`-imported directly — this script re-implements ONLY its generic
 * OAuth-token-fetch-and-POST plumbing below (`igdbPost` etc.), which is
 * boilerplate, not business logic, and is exactly the kind of small, self-
 * contained duplication `isLocalDatabaseUrl`/`normalizeTitle` already
 * establish as this directory's convention.
 *
 * TESTABILITY
 *
 * The pure helpers below are `export`ed so tests/unit/games-backfill-
 * metadata.test.ts can exercise them directly, the same pattern
 * games-import-parsers.test.ts already uses against import-game-log.mjs. The
 * CLI body lives in `main()`, invoked only when this file is run directly
 * (guarded below via `import.meta.url`) — importing this module for its
 * exports must never open a database connection, hit the network, or touch
 * `process.argv`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import postgres from 'postgres';

import {
  bestTitleMatch,
  buildSearchQuery,
  buildTimeToBeatQuery,
  metadataFieldsToFill,
  toSuggestions,
  withPlaytime,
} from '../src/server/games/metadata.ts';

// Same set import-game-log.mjs, fix-game-platforms.mjs and
// src/server/db/seed-guard.ts use for the identical local-only guard.
// Duplicated rather than imported — every script in this directory stays
// self-contained (see the header comment above for why THIS script is the
// one exception, and only for the pure IGDB query/scoring logic).
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const DEFAULT_REPORT_PATH = path.join(os.tmpdir(), 'burmy-game-metadata-backfill-report.txt');

const TIMEOUT_MS = 5_000;
const SEARCH_LIMIT = 10;
const TOKEN_ENDPOINT = 'https://id.twitch.tv/oauth2/token';
const GAMES_ENDPOINT = 'https://api.igdb.com/v4/games';
const TIME_TO_BEAT_ENDPOINT = 'https://api.igdb.com/v4/game_time_to_beats';

/**
 * Whether a Postgres connection string points at a local database. Identical
 * logic to import-game-log.mjs's and fix-game-platforms.mjs's own
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
 * Parses this script's CLI: one required positional (owner email), an
 * optional `--apply` flag, and an optional `--report <path>` flag. Pure and
 * exported so its edge cases (flag order, a missing `--report` value) are
 * unit-testable without touching `process.argv`.
 */
export function parseArgs(argv) {
  const args = argv.slice(2);
  let ownerEmail;
  let apply = false;
  let reportPath;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--report') {
      i += 1;
      reportPath = args[i];
    } else if (ownerEmail === undefined) {
      ownerEmail = arg;
    }
  }

  return { ownerEmail, apply, reportPath };
}

/**
 * Self-imposed throttle for IGDB's documented 4 requests/second limit.
 * Spaces every request (token fetch included) at least MIN_INTERVAL_MS apart
 * — a hair over the exact 250ms that 4/s implies — via a single shared
 * "earliest next request time" watermark. That keeps the WHOLE request
 * stream under the limit, not just a rolling average, which matters here
 * because every game issues two back-to-back requests (search, then
 * time-to-beat) in its own await chain with no other concurrency in this
 * script to smooth things out.
 */
const MIN_INTERVAL_MS = 260;
let nextRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle() {
  const now = Date.now();
  const waitMs = Math.max(0, nextRequestAt - now);
  nextRequestAt = Math.max(now, nextRequestAt) + MIN_INTERVAL_MS;
  if (waitMs > 0) await sleep(waitMs);
}

// Module-scope token cache, same shape as src/server/db/games/igdb.ts's own
// (that file can't be `node`-imported here — see the file header). A 401
// clears this and the next request fetches a fresh token, retried exactly
// once, never in a loop — identical contract to igdb.ts's `igdbPost`.
let cachedToken = null;

async function fetchToken(clientId, clientSecret) {
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
  });
  await throttle();
  const response = await fetch(`${TOKEN_ENDPOINT}?${params.toString()}`, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) return null;

  const body = await response.json();
  if (typeof body !== 'object' || body === null) return null;
  if (typeof body.access_token !== 'string' || body.access_token === '') return null;
  if (typeof body.expires_in !== 'number') return null;

  return { token: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
}

async function getToken(clientId, clientSecret) {
  if (cachedToken !== null && cachedToken.expiresAt > Date.now()) return cachedToken.token;
  cachedToken = await fetchToken(clientId, clientSecret);
  return cachedToken?.token ?? null;
}

function requestInit(token, clientId, body) {
  return {
    method: 'POST',
    headers: { 'Client-ID': clientId, Authorization: `Bearer ${token}`, Accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
}

/** POSTs an Apicalypse body to an IGDB endpoint, throttled, with one 401 retry. Returns `null`, never throws on a soft failure. */
async function igdbPost(endpoint, body, clientId, clientSecret) {
  const token = await getToken(clientId, clientSecret);
  if (token === null) return null;

  await throttle();
  let response = await fetch(endpoint, requestInit(token, clientId, body));

  if (response.status === 401) {
    cachedToken = null;
    const freshToken = await getToken(clientId, clientSecret);
    if (freshToken === null) return null;
    await throttle();
    response = await fetch(endpoint, requestInit(freshToken, clientId, body));
  }

  if (!response.ok) return null;
  return response.json();
}

/**
 * Searches IGDB for one stored title and returns candidate suggestions with
 * playtime merged in — the same two-call shape as
 * `src/server/db/games/igdb.ts`'s `searchGames`, reusing its exact query
 * builders and response shaper. Unlike that function (which degrades to `[]`
 * on any error, correct for a live autocomplete UI that must never crash a
 * form), this one lets a thrown error propagate: the CALLER needs to tell
 * "IGDB returned no results" apart from "the request to IGDB failed," because
 * only the first belongs in the report as a plain "no match."
 */
async function searchGame(title, clientId, clientSecret) {
  const payload = await igdbPost(GAMES_ENDPOINT, buildSearchQuery(title, SEARCH_LIMIT), clientId, clientSecret);
  if (payload === null) throw new Error('IGDB search request failed');
  const suggestions = toSuggestions(payload);
  if (suggestions.length === 0) return suggestions;

  const gameIds = suggestions.map((s) => Number(s.externalId)).filter((id) => Number.isFinite(id));
  if (gameIds.length === 0) return suggestions;

  // Time-to-beat is a bonus enrichment on an already-successful search, same
  // as igdb.ts's own contract — its failure must never blank out real
  // matches, so it degrades to un-enriched suggestions rather than throwing.
  const timeToBeatPayload = await igdbPost(
    TIME_TO_BEAT_ENDPOINT,
    buildTimeToBeatQuery(gameIds),
    clientId,
    clientSecret,
  );
  return timeToBeatPayload === null ? suggestions : withPlaytime(suggestions, timeToBeatPayload);
}

/** Human-readable "which columns" list for one game's report entry, e.g. `"genre, metacritic"`. */
export function formatFillList(fill) {
  const parts = [];
  if (fill.coverUrl !== undefined) parts.push('cover_url');
  if (fill.genre !== undefined) parts.push('genre');
  if (fill.metacritic !== undefined) parts.push('metacritic');
  if (fill.averagePlaytimeHours !== undefined) parts.push('average_playtime_hours');
  if (fill.esrbRating !== undefined) parts.push('esrb_rating');
  return parts.length === 0 ? '(nothing new to fill)' : parts.join(', ');
}

const SECTION_RULE = '='.repeat(78);

/**
 * Builds the full human-readable report text. LOW confidence and no-match
 * results are grouped FIRST, under their own clearly-marked section, per the
 * task's explicit requirement that they "cannot be missed" — those are the
 * ones needing the owner's decision. HIGH confidence results — the ones the
 * script would apply (or has applied) — follow in their own section.
 */
export function buildReport({ results, apply, appliedCount, highCount, lowCount, noMatchCount }) {
  const lines = [];
  lines.push('IGDB game metadata backfill report');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Mode: ${apply ? 'APPLIED (high confidence only)' : 'DRY RUN — no database writes were made'}`);
  lines.push('');
  lines.push('SUMMARY');
  lines.push(`  Total games processed:    ${results.length}`);
  lines.push(`  High confidence matches:  ${highCount}`);
  lines.push(`  Low confidence matches:   ${lowCount}`);
  lines.push(`  No match found:           ${noMatchCount}`);
  if (apply) lines.push(`  Applied to the database:  ${appliedCount}`);
  lines.push('');

  const noMatch = results.filter((r) => r.match === null);
  const low = results.filter((r) => r.match !== null && r.match.score.confidence === 'low');
  const high = results.filter((r) => r.match !== null && r.match.score.confidence === 'high');

  lines.push(SECTION_RULE);
  lines.push('NEEDS YOUR DECISION — low confidence or no match (never auto-applied)');
  lines.push(SECTION_RULE);
  lines.push('');
  if (noMatch.length === 0 && low.length === 0) {
    lines.push('(none)');
    lines.push('');
  } else {
    for (const r of noMatch) {
      lines.push(`[NO MATCH]        "${r.title}" (${r.platform})`);
      lines.push(r.errorMessage !== undefined ? `  IGDB request failed: ${r.errorMessage}` : '  IGDB returned no search results.');
      lines.push('');
    }
    for (const r of low) {
      lines.push(`[LOW CONFIDENCE]  "${r.title}" (${r.platform})`);
      lines.push(
        `  Matched IGDB title: "${r.match.suggestion.title}" (title similarity ${r.match.score.similarity.toFixed(2)}, 1.00 = identical, higher is better)`,
      );
      lines.push(`  Would fill: ${formatFillList(r.fill)}`);
      lines.push('');
    }
  }

  lines.push(SECTION_RULE);
  lines.push(`HIGH CONFIDENCE — ${apply ? 'applied' : 'will apply with --apply'}`);
  lines.push(SECTION_RULE);
  lines.push('');
  if (high.length === 0) {
    lines.push('(none)');
    lines.push('');
  } else {
    for (const r of high) {
      lines.push(`[HIGH CONFIDENCE] "${r.title}" (${r.platform})`);
      lines.push(`  Matched IGDB title: "${r.match.suggestion.title}"`);
      lines.push(`  ${apply ? 'Filled' : 'Would fill'}: ${formatFillList(r.fill)}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Writes one game's HIGH-confidence fill to the database. Every assigned
 * column goes through `coalesce(column, $new)` — defense-in-depth on top of
 * `metadataFieldsToFill`'s own null-check, so a column that somehow already
 * holds a value (a concurrent edit, or a re-run after a partial apply) is
 * still never overwritten. `fill` values default to `null` in the query for
 * any column this particular match didn't provide, which `coalesce` turns
 * into a no-op against the existing value.
 */
async function applyFill(sql, ownerId, gameId, fill) {
  await sql`
    update games set
      cover_url = coalesce(cover_url, ${fill.coverUrl ?? null}),
      genre = coalesce(genre, ${fill.genre ?? null}),
      metacritic = coalesce(metacritic, ${fill.metacritic ?? null}),
      average_playtime_hours = coalesce(average_playtime_hours, ${fill.averagePlaytimeHours ?? null}),
      esrb_rating = coalesce(esrb_rating, ${fill.esrbRating ?? null}),
      updated_at = now()
    where id = ${gameId} and owner_id = ${ownerId}
  `;
}

async function main() {
  const { ownerEmail, apply, reportPath: reportPathArg } = parseArgs(process.argv);

  if (!ownerEmail) {
    console.error('Usage: node scripts/backfill-game-metadata.mjs <owner-email> [--apply] [--report <path>]');
    console.error('Defaults to a DRY RUN. Pass --apply to write HIGH-confidence matches to the database.');
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  if (!isLocalDatabaseUrl(databaseUrl)) {
    console.error('Refusing to run against a non-local database. Backfill locally, then migrate deliberately.');
    process.exit(1);
  }

  const clientId = process.env.IGDB_CLIENT_ID;
  const clientSecret = process.env.IGDB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('IGDB_CLIENT_ID / IGDB_CLIENT_SECRET are not set. Nothing can be fetched without them.');
    process.exit(1);
  }

  const reportPath = reportPathArg ?? DEFAULT_REPORT_PATH;
  const email = ownerEmail.trim().toLowerCase();
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    const [owner] = await sql`select id from "user" where email = ${email} limit 1`;
    if (!owner) {
      console.error(`No user row for ${email}. Provision the owner first.`);
      process.exitCode = 1;
      return;
    }

    const rows = await sql`
      select id, title, platform, cover_url, genre, metacritic, average_playtime_hours, esrb_rating
      from games
      where owner_id = ${owner.id}
      order by title
    `;

    if (rows.length === 0) {
      console.log(`No games found for ${email}.`);
      return;
    }

    console.log(`${apply ? 'APPLY' : 'DRY RUN'}: matching ${rows.length} games against IGDB (throttled to ~4 req/s)...`);

    const results = [];
    let processed = 0;

    for (const row of rows) {
      processed += 1;

      const current = {
        coverUrl: row.cover_url,
        genre: row.genre,
        metacritic: row.metacritic,
        averagePlaytimeHours: row.average_playtime_hours,
        esrbRating: row.esrb_rating,
      };

      let match = null;
      let errorMessage;
      try {
        const suggestions = await searchGame(row.title, clientId, clientSecret);
        match = bestTitleMatch(row.title, suggestions);
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : 'unknown error';
      }

      const fill = match !== null ? metadataFieldsToFill(current, match.suggestion) : {};
      results.push({ id: row.id, title: row.title, platform: row.platform, match, fill, errorMessage });

      if (processed % 20 === 0 || processed === rows.length) {
        console.log(`  ...${processed}/${rows.length}`);
      }
    }

    let highCount = 0;
    let lowCount = 0;
    let noMatchCount = 0;
    for (const r of results) {
      if (r.match === null) noMatchCount += 1;
      else if (r.match.score.confidence === 'high') highCount += 1;
      else lowCount += 1;
    }

    let appliedCount = 0;
    if (apply) {
      for (const r of results) {
        if (r.match === null || r.match.score.confidence !== 'high') continue;
        if (Object.keys(r.fill).length === 0) continue; // nothing left to write for this game
        await applyFill(sql, owner.id, r.id, r.fill);
        appliedCount += 1;
      }
    }

    const reportText = buildReport({ results, apply, appliedCount, highCount, lowCount, noMatchCount });
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, reportText, 'utf8');

    console.log('');
    console.log(`Total: ${rows.length}  High: ${highCount}  Low: ${lowCount}  No match: ${noMatchCount}`);
    console.log(
      apply
        ? `Applied ${appliedCount} high-confidence update(s) to the database.`
        : 'DRY RUN — no database writes were made. Review the report, then re-run with --apply if it looks right.',
    );
    console.log(`Report written to: ${reportPath}`);
  } catch (error) {
    // Log the message only. This table holds the owner's personal game
    // library, same privacy posture as Finance and the other games scripts.
    console.error('Backfill failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  await main();
}
