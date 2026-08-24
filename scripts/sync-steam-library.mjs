#!/usr/bin/env node
/**
 * One-off sync of Steam playtime/achievements into the `games` library,
 * replacing hand entry for the 47 Steam/PC titles already imported by
 * scripts/import-game-log.mjs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * See `.superpowers/sdd/2026-08-20-game-tracker/psn-integration-research.md`
 * for the evaluation that led here. In short: Steam's Web API is official,
 * documented, and has no expiring credential — a real contrast to the PSN
 * side (an unofficial API behind a ~60-day manual NPSSO re-auth chore),
 * which stays a research note, not code. A one-off, run-on-demand script is
 * the right shape for a personal tool whose data changes at "finished a
 * game" cadence — not a live in-app integration.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SAFETY: DRY RUN BY DEFAULT — THIS IS THE MOST IMPORTANT THING ABOUT THIS FILE
 *
 * Same posture as backfill-game-metadata.mjs, for the same reason: matching
 * a locally-typed title against a third-party catalog is genuinely
 * error-prone, and this script additionally touches numbers the owner typed
 * BY HAND from a spreadsheet they trust. So:
 *
 *   - No database write happens without the explicit `--apply` flag.
 *   - Even with `--apply`, a column is only ever FILLED where it is
 *     currently NULL (`steam_appid`, `achievements_total`, and
 *     `achievements_unlocked`/`hours_tenths` where empty) — see
 *     `steamSyncFieldsToFill` in src/server/games/steam.ts, which is the
 *     single source of truth for that rule.
 *   - A column that already holds a value and DIFFERS from what Steam
 *     reports is never silently overwritten. Every difference is written to
 *     the report either way. `hours_tenths` is the one field with an
 *     overwrite path at all — Steam's measured playtime is more accurate
 *     than a hand-typed estimate — and even that requires the separate,
 *     explicit `--overwrite-hours` flag on top of `--apply`.
 *   - `achievements_unlocked`/`achievements_total` have NO overwrite path.
 *     A difference there is reported and left alone, full stop.
 *   - `platinum` is NEVER touched by this script. A platinum is a
 *     PlayStation trophy; 100% Steam achievements is not the same concept
 *     and has no Steam-derived equivalent — see docs/GAMES.md. Do not wire
 *     this up later without re-reading that reasoning.
 *   - A Steam-owned game with no matching library row is listed in the
 *     report and NEVER imported as a new row — the owner's library is
 *     curated, and importing their whole Steam account is not this
 *     script's job.
 *   - Matching is scoped to `platform = 'steam'` library rows only. Nothing
 *     about a PS5/PS4/PSP title should ever be compared against a Steam
 *     appid.
 *   - `STEAM_ID` accepts either a SteamID64 (the 17-digit numeric id
 *     `GetOwnedGames` actually requires) or a vanity name (the `<name>` in
 *     `steamcommunity.com/id/<name>`) — a vanity name is resolved to a
 *     SteamID64 via `ResolveVanityURL` before anything else runs, and what
 *     it resolved to is printed so the owner can confirm it worked. See
 *     `isSteamId64`/`buildResolveVanityUrl`/`toResolvedVanityUrl` in
 *     src/server/games/steam.ts.
 *   - If the owned-games fetch itself FAILS (bad SteamID64, network error,
 *     non-2xx, malformed JSON), the script ABORTS with a non-zero exit
 *     instead of producing a report — "the request failed" and "this
 *     account owns zero games" are different facts, and a report built from
 *     an empty snapshot after a failed request would report every single
 *     library row as unmatched, which is a confident, meaningless lie, not
 *     a diff. This is stricter than `steam-client.ts`'s own soft-failure
 *     contract (`[]`/`null`, never throws) on purpose — that contract is
 *     right for the app, where cover art must never break a page; it is
 *     wrong for a script whose entire job is reporting a diff.
 *
 * Usage:
 *   node --env-file-if-exists=.env scripts/sync-steam-library.mjs <owner-email> \
 *     [--apply] [--overwrite-hours] [--report <path>]
 *
 * `--report <path>` overrides the report location (default: a fixed path
 * under the OS temp directory, deliberately OUTSIDE this repo — same rule
 * backfill-game-metadata.mjs follows, since this report describes the
 * owner's real personal game library).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY PLAIN ESM, AND WHY THIS SCRIPT RE-IMPLEMENTS ITS OWN FETCH PLUMBING
 *
 * Same reasoning as the other scripts in this directory for staying plain
 * ESM: this only needs `postgres` (already a production dependency) and
 * `fetch` (built into Node 24).
 *
 * This script imports `../src/server/games/steam.ts` and
 * `../src/server/games/metadata.ts` directly — both are, and must remain,
 * LEAF modules (no imports of their own): a bare `node` invocation resolves
 * an ordinary `.ts` relative import fine, but its ESM resolver still
 * requires an explicit, resolvable specifier at every hop of the chain
 * (verified directly — an extensionless `./metadata` import throws
 * `ERR_MODULE_NOT_FOUND` under bare `node`, though the identical import
 * resolves fine under `tsc`/Next's bundler). `src/server/db/games/
 * steam-client.ts` — the actual fetch — imports `steam.ts` via the `@/`
 * alias, which a bare `node` invocation cannot resolve at all without a
 * bundler or a tsconfig-paths loader, so THAT file cannot be imported here
 * either. This script therefore re-implements the fetch-and-throttle
 * plumbing itself, the same way backfill-game-metadata.mjs re-implements
 * `igdb.ts`'s OAuth-token-fetch-and-POST plumbing while importing the real
 * URL-building/response-shaping logic from `metadata.ts` — duplicating
 * boilerplate fetch code is fine; duplicating the response-shaping or
 * matching logic itself is exactly what CLAUDE.md's dedupe_key gotcha warns
 * against, which is why none of that is reimplemented here.
 *
 * TESTABILITY
 *
 * The pure helpers below are `export`ed so
 * tests/unit/games-sync-steam-library.test.ts can exercise them directly,
 * the same pattern games-backfill-metadata.test.ts already uses. The CLI
 * body lives in `main()`, invoked only when this file is run directly
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

import { bestTitleMatchAmong } from '../src/server/games/metadata.ts';
import { minutesToHoursTenths } from '../src/server/games/hours.ts';
import {
  buildAchievementsUrl,
  buildOwnedGamesUrl,
  buildResolveVanityUrl,
  isSteamId64,
  steamSyncFieldsToFill,
  toAchievementCounts,
  toOwnedGames,
  toResolvedVanityUrl,
} from '../src/server/games/steam.ts';

// Same set import-game-log.mjs, fix-game-platforms.mjs and
// backfill-game-metadata.mjs all use for the identical local-only guard.
// Duplicated rather than imported — every script in this directory stays
// self-contained.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const DEFAULT_REPORT_PATH = path.join(os.tmpdir(), 'burmy-steam-library-sync-report.txt');

const TIMEOUT_MS = 5_000;

/**
 * Whether a Postgres connection string points at a local database. Identical
 * logic to the other games scripts' own `isLocalDatabaseUrl`.
 */
export function isLocalDatabaseUrl(url) {
  try {
    return LOCAL_HOSTNAMES.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Parses this script's CLI: one required positional (owner email), and the
 * `--apply` / `--overwrite-hours` / `--report <path>` flags. Pure and
 * exported so its edge cases are unit-testable without touching
 * `process.argv`.
 */
export function parseArgs(argv) {
  const args = argv.slice(2);
  let ownerEmail;
  let apply = false;
  let overwriteHours = false;
  let reportPath;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--overwrite-hours') {
      overwriteHours = true;
    } else if (arg === '--report') {
      i += 1;
      reportPath = args[i];
    } else if (ownerEmail === undefined) {
      ownerEmail = arg;
    }
  }

  return { ownerEmail, apply, overwriteHours, reportPath };
}

/**
 * Self-imposed politeness throttle. Steam publishes a generous 100,000
 * calls/day quota for `api.steampowered.com` and no documented per-second
 * limit the way IGDB does — at library scale (one owned-games call, then at
 * most one achievements call per matched game) this run stays under 100
 * requests total either way, so this exists purely to be a considerate
 * caller, not to dodge a hard limit. Same shared-watermark shape as
 * backfill-game-metadata.mjs's own `throttle`.
 */
const MIN_INTERVAL_MS = 300;
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

/**
 * Resolves `STEAM_ID` to a real SteamID64. A 17-digit value is used as-is,
 * no request made — see `isSteamId64`. Anything else is treated as a vanity
 * name (the `<name>` in `steamcommunity.com/id/<name>`) and resolved via
 * `ISteamUser/ResolveVanityURL/v1`.
 *
 * THROWS on both "the resolution request itself failed" and "the name
 * didn't resolve to any profile" (Steam's `success: 42`) — same
 * throw-on-failure reasoning as `fetchOwnedGamesList`/`fetchAchievements`
 * below: this script's whole job is a diff report, and silently falling
 * back to the raw (wrong) value would send a malformed SteamID64 straight
 * into `GetOwnedGames`, producing exactly the "0 owned games, 47 unmatched"
 * false report this fix exists to prevent.
 */
async function resolveSteamId(rawSteamId, apiKey) {
  if (isSteamId64(rawSteamId)) return rawSteamId;

  await throttle();
  let response;
  try {
    response = await fetch(buildResolveVanityUrl(apiKey, rawSteamId), { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new Error(
      `resolving vanity name "${rawSteamId}" failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
  if (!response.ok) throw new Error(`resolving vanity name "${rawSteamId}" failed: HTTP ${response.status}`);

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`resolving vanity name "${rawSteamId}" failed: malformed JSON response`);
  }

  const resolved = toResolvedVanityUrl(payload);
  if (resolved === null) {
    throw new Error(
      `Steam could not resolve "${rawSteamId}" as a vanity name (steamcommunity.com/id/${rawSteamId}). ` +
        'STEAM_ID accepts either your SteamID64 (the 17-digit id) or that vanity name. To find your ' +
        'SteamID64: open your Steam profile in a browser — if the URL already reads ' +
        '/profiles/<17 digits>, that number is it; otherwise look it up at https://steamid.io by pasting ' +
        'in your profile URL.',
    );
  }
  return resolved.steamId;
}

/**
 * Fetches and shapes the owner's full Steam library. Unlike
 * `steam-client.ts`'s soft-failing `fetchOwnedGames` (correct for a contract
 * the whole app's test suite must pass under with no credentials at all),
 * this THROWS on a request failure — the caller needs to tell "Steam
 * returned zero games" (a real, reportable fact — usually a private
 * profile) apart from "the request to Steam failed" (a different fact that
 * belongs in the report as its own line, not silently folded into "0
 * games").
 */
async function fetchOwnedGamesList(apiKey, steamId) {
  await throttle();
  let response;
  try {
    response = await fetch(buildOwnedGamesUrl(apiKey, steamId), { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`request failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('malformed JSON response');
  }
  return toOwnedGames(payload);
}

/**
 * Fetches and shapes one game's achievement counts. Same throw-on-failure
 * reasoning as `fetchOwnedGamesList` — `toAchievementCounts` returning
 * `null` for a SUCCESSFUL response (Steam's error-shaped "no stats" body)
 * must stay distinguishable from the request itself failing.
 */
async function fetchAchievements(appid, apiKey, steamId) {
  await throttle();
  let response;
  try {
    response = await fetch(buildAchievementsUrl(apiKey, steamId, appid), { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`request failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('malformed JSON response');
  }
  return toAchievementCounts(payload);
}

/**
 * Differences between what is currently stored and what Steam reports, for
 * every column that has one — regardless of whether this script has any way
 * to act on that difference. `steam_appid` has no diff concept: matching
 * only ever runs against rows with a null `steam_appid` in the first place,
 * so an "already matched" row's appid cannot disagree with itself.
 */
export function computeSteamDiffs(current, achievements, hoursTenthsFromSteam) {
  const diffs = {};
  if (current.achievementsUnlocked !== null && achievements !== null && achievements.unlocked !== current.achievementsUnlocked) {
    diffs.achievementsUnlocked = { stored: current.achievementsUnlocked, steam: achievements.unlocked };
  }
  if (current.achievementsTotal !== null && achievements !== null && achievements.total !== current.achievementsTotal) {
    diffs.achievementsTotal = { stored: current.achievementsTotal, steam: achievements.total };
  }
  if (current.hoursTenths !== null && hoursTenthsFromSteam !== null && hoursTenthsFromSteam !== current.hoursTenths) {
    diffs.hoursTenths = { stored: current.hoursTenths, steam: hoursTenthsFromSteam };
  }
  return diffs;
}

/** `53h` / `0.7h` display, duplicated as a tiny formatter rather than importing formatHours's `hours()` brand check for plain numbers from a DB row. */
function displayHours(tenths) {
  const whole = Math.trunc(tenths / 10);
  const remainder = tenths % 10;
  return remainder === 0 ? `${whole}h` : `${(tenths / 10).toFixed(1)}h`;
}

/** Human-readable "which columns" list for one game's report entry, e.g. `"achievements_total, hours_tenths"`. */
export function formatSteamFillList(fill) {
  const parts = [];
  if (fill.steamAppid !== undefined) parts.push('steam_appid');
  if (fill.achievementsTotal !== undefined) parts.push('achievements_total');
  if (fill.achievementsUnlocked !== undefined) parts.push('achievements_unlocked');
  if (fill.hoursTenths !== undefined) parts.push(`hours_tenths (${displayHours(fill.hoursTenths)})`);
  return parts.length === 0 ? '(nothing new to fill)' : parts.join(', ');
}

const SECTION_RULE = '='.repeat(78);

/**
 * Builds the full human-readable report text.
 *
 * Section order deliberately puts everything needing the owner's own
 * decision FIRST (Steam-owned games with no library row, then low
 * confidence/unmatched/differing values), and what the script did or would
 * do automatically LAST — mirroring backfill-game-metadata.mjs's own
 * report shape for the same reason: the part a human has to act on should
 * never be buried under a long list of routine, already-handled rows.
 */
export function buildReport({
  results,
  steamOnlyGames,
  ownedGamesFetchError,
  ownedGamesCount,
  apply,
  overwriteHours,
  appliedCount,
  hoursOverwrittenCount,
}) {
  const lines = [];
  lines.push('Steam library sync report');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Mode: ${apply ? 'APPLIED' : 'DRY RUN — no database writes were made'}`);
  lines.push(`--overwrite-hours: ${overwriteHours ? 'enabled' : 'disabled'}`);
  lines.push('');

  if (ownedGamesFetchError !== undefined) {
    lines.push(`WARNING: fetching the Steam owned-games list failed: ${ownedGamesFetchError}`);
    lines.push('Continuing with an empty Steam library snapshot for this run — every row below is unmatched.');
    lines.push('');
  } else if (ownedGamesCount === 0) {
    lines.push(
      'WARNING: Steam returned 0 owned games. Check STEAM_API_KEY/STEAM_ID, and that this Steam ' +
        'account\'s "Game details" privacy is set to Public — Steam returns an empty list either way, ' +
        'with no error to tell the two apart.',
    );
    lines.push('');
  }

  const alreadyMatched = results.filter((r) => r.matchKind === 'already-matched');
  const newHigh = results.filter((r) => r.matchKind === 'high');
  const newLow = results.filter((r) => r.matchKind === 'low');
  const unmatched = results.filter((r) => r.matchKind === 'no-candidates');
  const withDiffs = results.filter((r) => Object.keys(r.diffs).length > 0);

  lines.push('SUMMARY');
  lines.push(`  Steam-platform library rows:            ${results.length}`);
  lines.push(`  Already matched (steam_appid on file):  ${alreadyMatched.length}`);
  lines.push(`  Newly matched — high confidence:        ${newHigh.length}`);
  lines.push(`  Newly matched — low confidence:         ${newLow.length} (never auto-applied)`);
  lines.push(`  Unmatched (no Steam candidate found):   ${unmatched.length}`);
  lines.push(`  Steam-owned games with no library row:  ${steamOnlyGames.length} (listed only, never imported)`);
  lines.push(`  Rows with a stored/Steam difference:    ${withDiffs.length}`);
  if (apply) {
    lines.push(`  Filled (steam_appid/achievements/hours-if-empty): ${appliedCount}`);
    lines.push(`  Hours overwritten via --overwrite-hours:          ${hoursOverwrittenCount}`);
  }
  lines.push('');

  lines.push(SECTION_RULE);
  lines.push('STEAM-OWNED GAMES WITH NO LIBRARY ROW — listed only, never imported');
  lines.push(SECTION_RULE);
  lines.push('');
  if (steamOnlyGames.length === 0) {
    lines.push('(none)');
    lines.push('');
  } else {
    for (const game of steamOnlyGames) {
      lines.push(`  "${game.name}" (appid ${game.appid}, ${displayHours(minutesToHoursTenths(game.playtimeMinutes))})`);
    }
    lines.push('');
  }

  lines.push(SECTION_RULE);
  lines.push('NEEDS YOUR REVIEW — low confidence, unmatched, or a stored value differs from Steam');
  lines.push(SECTION_RULE);
  lines.push('');
  if (newLow.length === 0 && unmatched.length === 0 && withDiffs.length === 0) {
    lines.push('(none)');
    lines.push('');
  } else {
    for (const r of newLow) {
      lines.push(`[LOW CONFIDENCE]  "${r.title}"`);
      lines.push(`  Closest Steam title: "${r.matchedSteamName}" (edit-distance score ${r.score.toFixed(2)}) — never auto-applied.`);
      lines.push('');
    }
    for (const r of unmatched) {
      lines.push(`[NO MATCH]        "${r.title}"`);
      lines.push('  No Steam-owned game title came close enough to compare.');
      lines.push('');
    }
    for (const r of withDiffs) {
      lines.push(`[DIFFERS]         "${r.title}"`);
      if (r.diffs.achievementsUnlocked !== undefined) {
        lines.push(
          `  achievements_unlocked: stored ${r.diffs.achievementsUnlocked.stored}, Steam reports ${r.diffs.achievementsUnlocked.steam} — not overwritten (no overwrite flag exists for this column).`,
        );
      }
      if (r.diffs.achievementsTotal !== undefined) {
        lines.push(
          `  achievements_total: stored ${r.diffs.achievementsTotal.stored}, Steam reports ${r.diffs.achievementsTotal.steam} — not overwritten (no overwrite flag exists for this column).`,
        );
      }
      if (r.diffs.hoursTenths !== undefined) {
        const stored = displayHours(r.diffs.hoursTenths.stored);
        const steam = displayHours(r.diffs.hoursTenths.steam);
        const disposition = !overwriteHours
          ? 'pass --overwrite-hours (with --apply) to overwrite'
          : apply
            ? 'OVERWRITTEN this run'
            : 'would be overwritten with --apply';
        lines.push(`  hours_tenths: stored ${stored}, Steam reports ${steam} — ${disposition}.`);
      }
      lines.push('');
    }
  }

  lines.push(SECTION_RULE);
  lines.push(`MATCHED — ${apply ? 'filled' : 'will fill with --apply'}`);
  lines.push(SECTION_RULE);
  lines.push('');
  if (alreadyMatched.length === 0 && newHigh.length === 0) {
    lines.push('(none)');
    lines.push('');
  } else {
    for (const r of alreadyMatched) {
      lines.push(`[ALREADY MATCHED] "${r.title}" (appid ${r.matchedAppid})`);
      lines.push(`  ${apply ? 'Filled' : 'Would fill'}: ${formatSteamFillList(r.fill)}`);
      if (r.achievementsError !== undefined) lines.push(`  Achievements fetch failed: ${r.achievementsError}`);
      lines.push('');
    }
    for (const r of newHigh) {
      lines.push(`[HIGH CONFIDENCE] "${r.title}" -> Steam "${r.matchedSteamName}" (appid ${r.matchedAppid})`);
      lines.push(`  ${apply ? 'Filled' : 'Would fill'}: ${formatSteamFillList(r.fill)}`);
      if (r.achievementsError !== undefined) lines.push(`  Achievements fetch failed: ${r.achievementsError}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Writes one game's fill to the database. Every column goes through
 * `coalesce(column, $new)` — defense-in-depth on top of
 * `steamSyncFieldsToFill`'s own null-check, so a column that somehow already
 * holds a value is never overwritten here. `fill` values default to `null`
 * for any column this game's fill didn't include, which `coalesce` turns
 * into a no-op.
 */
async function applyFill(sql, ownerId, gameId, fill) {
  await sql`
    update games set
      steam_appid = coalesce(steam_appid, ${fill.steamAppid ?? null}),
      achievements_total = coalesce(achievements_total, ${fill.achievementsTotal ?? null}),
      achievements_unlocked = coalesce(achievements_unlocked, ${fill.achievementsUnlocked ?? null}),
      hours_tenths = coalesce(hours_tenths, ${fill.hoursTenths ?? null}),
      updated_at = now()
    where id = ${gameId} and owner_id = ${ownerId}
  `;
}

/**
 * The ONE place `hours_tenths` is ever set unconditionally rather than
 * through `coalesce`. Only ever called when `--overwrite-hours` AND
 * `--apply` were both given AND a real difference was found — see `main`.
 */
async function applyHoursOverwrite(sql, ownerId, gameId, hoursTenths) {
  await sql`
    update games set hours_tenths = ${hoursTenths}, updated_at = now()
    where id = ${gameId} and owner_id = ${ownerId}
  `;
}

async function main() {
  const { ownerEmail, apply, overwriteHours, reportPath: reportPathArg } = parseArgs(process.argv);

  if (!ownerEmail) {
    console.error(
      'Usage: node scripts/sync-steam-library.mjs <owner-email> [--apply] [--overwrite-hours] [--report <path>]',
    );
    console.error('Defaults to a DRY RUN. Pass --apply to write. --overwrite-hours additionally overwrites a');
    console.error('differing hours_tenths (never achievements) — only takes effect together with --apply.');
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  if (!isLocalDatabaseUrl(databaseUrl)) {
    console.error('Refusing to run against a non-local database. Sync locally, then migrate deliberately.');
    process.exit(1);
  }

  const apiKey = process.env.STEAM_API_KEY;
  const rawSteamId = process.env.STEAM_ID;
  if (!apiKey || !rawSteamId) {
    console.error('STEAM_API_KEY / STEAM_ID are not set. Nothing can be fetched without them.');
    console.error('Get an API key at https://steamcommunity.com/dev/apikey. STEAM_ID accepts either your');
    console.error('SteamID64 (17 digits) or the vanity name from steamcommunity.com/id/<name>.');
    process.exit(1);
  }

  let steamId;
  try {
    steamId = await resolveSteamId(rawSteamId, apiKey);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'unknown error');
    process.exit(1);
  }
  if (steamId !== rawSteamId) {
    console.log(`Resolved STEAM_ID vanity name "${rawSteamId}" to SteamID64 ${steamId}.`);
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

    // Scoped to platform = 'steam' only — matching a PS5/PS4/PSP title
    // against a Steam appid would be a category error, and the owner's PSP
    // library in particular has no Steam-side equivalent at all.
    const rows = await sql`
      select id, title, steam_appid, achievements_unlocked, achievements_total, hours_tenths
      from games
      where owner_id = ${owner.id} and platform = 'steam'
      order by title
    `;

    if (rows.length === 0) {
      console.log(`No Steam-platform games found for ${email}.`);
      return;
    }

    console.log(`Fetching the Steam owned-games list for SteamID ${steamId}...`);
    let ownedGames;
    try {
      ownedGames = await fetchOwnedGamesList(apiKey, steamId);
    } catch (error) {
      const ownedGamesFetchError = error instanceof Error ? error.message : 'unknown error';
      console.error(`Failed to fetch the Steam owned-games list: ${ownedGamesFetchError}`);
      console.error(
        'Aborting — a failed request is not the same as "this Steam account owns zero games." ' +
          'Continuing would match every Steam-platform library row against an empty snapshot and print ' +
          'a confident but meaningless "0 matched" summary. Fix the underlying issue (check ' +
          'STEAM_API_KEY/STEAM_ID and network access) and re-run; no report was written.',
      );
      process.exitCode = 1;
      return;
    }

    if (ownedGames.length === 0) {
      console.log(
        'Steam returned 0 owned games. This usually means STEAM_API_KEY/STEAM_ID are wrong, or the ' +
          'account\'s "Game details" privacy is not set to Public.',
      );
    } else {
      console.log(`Steam reports ${ownedGames.length} owned game(s).`);
    }

    const ownedByAppid = new Map(ownedGames.map((g) => [g.appid, g]));
    const claimedAppids = new Set();

    console.log(`${apply ? 'APPLY' : 'DRY RUN'}: matching ${rows.length} Steam-platform games (throttled)...`);

    const results = [];
    let processed = 0;

    for (const row of rows) {
      processed += 1;

      const current = {
        steamAppid: row.steam_appid,
        achievementsUnlocked: row.achievements_unlocked,
        achievementsTotal: row.achievements_total,
        hoursTenths: row.hours_tenths,
      };

      let matchKind;
      let resolvedAppid = null;
      let matchedSteamName = null;
      let score = 0;

      if (row.steam_appid !== null) {
        matchKind = 'already-matched';
        resolvedAppid = row.steam_appid;
        matchedSteamName = ownedByAppid.get(resolvedAppid)?.name ?? null;
        claimedAppids.add(resolvedAppid);
      } else {
        const match = bestTitleMatchAmong(row.title, ownedGames, (g) => g.name);
        if (match === null) {
          matchKind = 'no-candidates';
        } else if (match.score.confidence === 'high') {
          matchKind = 'high';
          resolvedAppid = match.candidate.appid;
          matchedSteamName = match.candidate.name;
          score = match.score.distance;
          claimedAppids.add(resolvedAppid);
        } else {
          matchKind = 'low';
          matchedSteamName = match.candidate.name;
          score = match.score.distance;
        }
      }

      let achievements = null;
      let achievementsError;
      if (resolvedAppid !== null) {
        try {
          achievements = await fetchAchievements(resolvedAppid, apiKey, steamId);
        } catch (error) {
          achievementsError = error instanceof Error ? error.message : 'unknown error';
        }
      }

      const ownedEntry = resolvedAppid !== null ? ownedByAppid.get(resolvedAppid) : undefined;
      const hoursTenthsFromSteam = ownedEntry !== undefined ? minutesToHoursTenths(ownedEntry.playtimeMinutes) : null;

      const fill = steamSyncFieldsToFill(current, resolvedAppid, achievements, hoursTenthsFromSteam);
      const diffs = computeSteamDiffs(current, achievements, hoursTenthsFromSteam);

      results.push({
        id: row.id,
        title: row.title,
        matchKind,
        matchedAppid: resolvedAppid,
        matchedSteamName,
        score,
        achievements,
        achievementsError,
        fill,
        diffs,
        hoursTenthsFromSteam,
      });

      if (processed % 10 === 0 || processed === rows.length) {
        console.log(`  ...${processed}/${rows.length}`);
      }
    }

    const steamOnlyGames = ownedGames.filter((g) => !claimedAppids.has(g.appid));

    let appliedCount = 0;
    let hoursOverwrittenCount = 0;
    if (apply) {
      for (const r of results) {
        const hasFill = Object.keys(r.fill).length > 0;
        if (hasFill) {
          try {
            await applyFill(sql, owner.id, r.id, r.fill);
            appliedCount += 1;
          } catch (error) {
            r.applyError = error instanceof Error ? error.message : 'unknown error';
          }
        }

        if (overwriteHours && r.diffs.hoursTenths !== undefined) {
          try {
            await applyHoursOverwrite(sql, owner.id, r.id, r.diffs.hoursTenths.steam);
            hoursOverwrittenCount += 1;
          } catch (error) {
            r.applyError = error instanceof Error ? error.message : 'unknown error';
          }
        }
      }
    }

    // ownedGamesFetchError is never passed here — a fetch failure already
    // returned early above, before this point is ever reached.
    const reportText = buildReport({
      results,
      steamOnlyGames,
      ownedGamesCount: ownedGames.length,
      apply,
      overwriteHours,
      appliedCount,
      hoursOverwrittenCount,
    });
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, reportText, 'utf8');

    const highCount = results.filter((r) => r.matchKind === 'already-matched' || r.matchKind === 'high').length;
    const lowCount = results.filter((r) => r.matchKind === 'low').length;
    const unmatchedCount = results.filter((r) => r.matchKind === 'no-candidates').length;

    console.log('');
    console.log(
      `Matched HIGH: ${highCount}  Matched LOW: ${lowCount}  Unmatched: ${unmatchedCount}  Steam-only: ${steamOnlyGames.length}`,
    );
    console.log(
      apply
        ? `Applied ${appliedCount} fill(s) and ${hoursOverwrittenCount} hours overwrite(s) to the database.`
        : 'DRY RUN — no database writes were made. Review the report, then re-run with --apply if it looks right.',
    );
    console.log(`Report written to: ${reportPath}`);
  } catch (error) {
    // Log the message only. This table holds the owner's personal game
    // library, same privacy posture as Finance and the other games scripts.
    console.error('Steam sync failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  await main();
}
