'use server';

/**
 * The chunked Steam sync engine.
 *
 * Walks the owner's Steam-platform library in small pages, matches each game
 * against a ONE-TIME snapshot of the owner's Steam library, and STAGES the
 * resulting changes for review — every action above `commitSyncRunAction`
 * below only produces `game_sync_changes` rows via `src/server/db/games/sync.ts`
 * and never writes to `games` itself. `commitSyncRunAction` is the one
 * exception: it is a thin wrapper around `commitSyncRun`, which is where the
 * staged changes actually get applied — see that function's own doc comment
 * in `src/server/db/games/sync.ts` for the commit's own invariants.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE NO-DELETE INVARIANT
 *
 * A library game whose title/appid Steam's response does not account for is
 * skipped and left completely untouched — no write of any kind reaches its
 * row. That falls out of the design rather than needing a special case: this
 * module never calls `createGame`/`updateGame`/`deleteGame` at all, only
 * read functions plus `appendSyncChanges`/`finishSyncRun` against the sync
 * tables. See `tests/integration/games-sync-actions.test.ts`'s invariant
 * test, which asserts a full unmatched row is byte-identical across the run.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { revalidatePath } from 'next/cache';

import { requireOwner } from '@/server/auth/owner';
import { SyncRunAlreadyCommittedError, SyncRunNotFoundError, SyncRunNotReadyError } from '@/server/db/games/errors';
import { countSteamGames, listSteamGamesChunk, listSteamGamesForMatching } from '@/server/db/games/games';
import { searchGames } from '@/server/db/games/igdb';
import { sumPlayYearsForGames } from '@/server/db/games/play-years';
import {
  appendSyncChanges,
  commitSyncRun,
  createSyncRun,
  finishSyncRun,
  getLastSuccessfulSyncTimes,
  getSyncRun,
  getSyncRunLibrary,
  listSyncChanges,
  listUnenrichedNewGameChanges,
  markNewGameChangeEnriched,
  setSyncChangeSelected,
} from '@/server/db/games/sync';
import { fetchAchievementCounts, fetchOwnedGames } from '@/server/db/games/steam-client';
import { minutesToHoursTenths } from '@/server/games/hours';
import { bestTitleMatchAmong, resolveNewGameMetadataFill } from '@/server/games/metadata';
import type { OwnedSteamGame } from '@/server/games/steam';
import { planLinkedGameChanges, planNewGameChange, type PlannedChange, type StoredGameForSync } from '@/server/games/sync-plan';
import { type ActionResult, fail, ok } from '../action-result';

/**
 * Library games processed per `advanceSteamSyncAction` call. Each matched
 * game costs one `fetchAchievementCounts` request, so a chunk is at most 5
 * outbound requests — comfortably inside any serverless timeout while
 * keeping a run's progress visibly live rather than one long spinner.
 */
const CHUNK_SIZE = 5;

export interface SyncProgress {
  readonly runId: string;
  readonly cursor: number;
  readonly total: number;
  readonly done: boolean;
  readonly changeCount: number;
}

/**
 * Defensively narrows the run's stored library snapshot back into
 * `OwnedSteamGame[]`. `getSyncRunLibrary` returns `unknown` on purpose — it
 * is a stored third-party snapshot, not a typed contract (see its own doc
 * comment in `src/server/db/games/sync.ts`) — so a malformed or missing
 * entry is skipped rather than thrown on, the same discipline
 * `toOwnedGames` (`src/server/games/steam.ts`) applies to the live API
 * response.
 */
function parseSteamLibrary(value: unknown): OwnedSteamGame[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry): OwnedSteamGame[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const { appid, name, playtimeMinutes, lastPlayedAt } = record;
    if (typeof appid !== 'number' || typeof name !== 'string' || typeof playtimeMinutes !== 'number') return [];
    // Tolerated as absent, not required: a run STARTED before Steam's
    // last-played was captured still has a stored snapshot without the field,
    // and that run must keep working rather than dropping every game as
    // malformed. Missing simply means "no update to propose."
    return [{ appid, name, playtimeMinutes, lastPlayedAt: typeof lastPlayedAt === 'string' ? lastPlayedAt : null }];
  });
}

/**
 * The appid this stored game resolves to against the run's Steam snapshot,
 * or `null` when Steam does not own it.
 *
 * CONTROLLER INVARIANT: when the game is already linked (`steamAppid` is
 * non-null), that STORED value is what gets returned — never a freshly
 * matched one. `bestTitleMatchAmong` only runs for a game with no stored
 * appid at all. `planLinkedGameChanges` does not defend against a
 * mismatched (stored appid, matched appid) pair; this caller contract is
 * what makes that impossible, and it must stay that way.
 */
function resolveAppid(
  game: { readonly title: string; readonly steamAppid: number | null },
  library: readonly OwnedSteamGame[],
): number | null {
  if (game.steamAppid !== null) return game.steamAppid;
  return bestTitleMatchAmong(game.title, library, (owned) => owned.name)?.candidate.appid ?? null;
}

/**
 * Every appid already accounted for by a library game — either linked
 * already or matched by title right now. Recomputed fresh from EVERY one of
 * the owner's Steam-platform games (not just what earlier chunks touched):
 * staging never writes to `games`, so a title match staged several chunks
 * ago is still invisible in the `steamAppid` column, and re-running the pure
 * match here is the only way to know which Steam-owned games genuinely have
 * no library counterpart.
 */
function matchedSteamAppids(
  storedGames: readonly { readonly title: string; readonly steamAppid: number | null }[],
  library: readonly OwnedSteamGame[],
): Set<number> {
  const matched = new Set<number>();
  for (const game of storedGames) {
    const appid = resolveAppid(game, library);
    if (appid !== null) matched.add(appid);
  }
  return matched;
}

/**
 * Whether Steam credentials are present in the environment.
 *
 * `fetchOwnedGames()` deliberately does NOT report this: with no
 * `STEAM_API_KEY`/`STEAM_ID` it returns `[]` — "no request was even
 * attempted" — the exact same value a genuinely empty, correctly configured
 * library would produce. `null` is reserved for a request that was actually
 * attempted and failed (network error, timeout, non-2xx, malformed JSON).
 * See `src/server/db/games/steam-client.ts`'s module header — that
 * contract is documented, unit-tested, and depended on by
 * `scripts/sync-steam-library.mjs`, and is not to be changed. Anything that
 * needs to know "is Steam configured at all" — this function, and
 * `startSteamSyncAction` below — has to check the environment directly
 * instead of inferring it from `fetchOwnedGames`'s return value.
 */
function steamCredentialsConfigured(): boolean {
  const apiKey = process.env.STEAM_API_KEY;
  const steamId = process.env.STEAM_ID;
  return apiKey !== undefined && apiKey !== '' && steamId !== undefined && steamId !== '';
}

/** Whether Steam credentials are configured, for the UI to decide whether to offer the sync entry point at all. */
export async function isSteamConfiguredAction(): Promise<boolean> {
  await requireOwner();
  return steamCredentialsConfigured();
}

/** The most recent successful sync time for each source, or `null` for a source that has never successfully synced. */
export interface LastSyncedTimes {
  readonly steam: Date | null;
  readonly psn: Date | null;
}

/**
 * Feeds the small "Synced …" line under both Sync buttons. Shared here
 * (rather than split across `sync-actions.ts`/`psn-actions.ts`) because
 * `getLastSuccessfulSyncTimes` itself is source-agnostic — one query,
 * grouped by `source` — and the Library page wants both sources' timestamps
 * from one round trip rather than two nearly-identical action calls.
 */
export async function getLastSyncedTimesAction(): Promise<LastSyncedTimes> {
  const owner = await requireOwner();
  const times = await getLastSuccessfulSyncTimes(owner.userId);
  return { steam: times.get('steam') ?? null, psn: times.get('psn') ?? null };
}

/**
 * Starts a run: fetches the owner's Steam library ONCE, snapshots it, and
 * creates a `game_sync_runs` row covering every Steam-platform library game.
 *
 * Never throws on a Steam failure, and never on a missing configuration —
 * both are refused with a field-free `ActionResult` message, not a crash.
 * Credentials are checked FIRST and explicitly, via the same
 * `steamCredentialsConfigured()` check `isSteamConfiguredAction` uses —
 * `fetchOwnedGames()` cannot tell "not configured" apart from "configured,
 * and genuinely owns zero games" (both return `[]`; see that function's own
 * doc comment). Only once credentials are confirmed present does a `null`
 * from `fetchOwnedGames()` mean what it actually means here: the request
 * itself failed.
 */
export async function startSteamSyncAction(): Promise<ActionResult & { readonly runId?: string }> {
  const owner = await requireOwner();

  if (!steamCredentialsConfigured()) {
    return fail('Steam is not configured — set STEAM_API_KEY and STEAM_ID to sync.');
  }

  const library = await fetchOwnedGames();
  if (library === null) {
    return fail('Steam did not respond. Try again in a moment.');
  }

  const total = await countSteamGames(owner.userId);
  const run = await createSyncRun(owner.userId, 'steam', total, library);

  return { ok: true, runId: run.id };
}

/**
 * Processes one chunk of a running sync: matches up to `CHUNK_SIZE` library
 * games against the run's Steam snapshot, stages the resulting changes, and
 * advances the keyset bookmark. On the chunk that comes back EMPTY, also
 * stages a `new_game` change for every Steam-owned game no library row
 * accounts for, then marks the run `ready`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY "DONE" IS AN EMPTY CHUNK, NOT `cursor >= total`
 *
 * `total` is a count taken once, at run creation — a snapshot, not a live
 * value. Pairing it with OFFSET/LIMIT pagination over `games.id` (a random
 * `defaultRandom()` UUID, not a monotonic sequence) has two failure modes,
 * both reproduced against real Postgres: deleting a not-yet-processed game
 * mid-run makes the cursor converge just short of `total` and never reach
 * it, stranding the run in `running` forever with `finishSyncRun` never
 * called; inserting a game whose id happens to sort before already-processed
 * rows shifts a later OFFSET page backward, restaging an already-processed
 * game's `link` change as a duplicate while the truly new game is never
 * seen at all.
 *
 * Keyset pagination (`listSteamGamesChunk`, `id > lastGameId`) and treating
 * an EMPTY page as the only "done" signal fixes both: a delete just means
 * one less row for the keyset walk to pass through — no position for it to
 * strand at — and an insert is either picked up (if its id sorts after the
 * bookmark) or missed until the next run (if it sorts before), never
 * duplicated. `cursor`/`total` remain in `SyncProgress`, but ONLY for
 * progress display ("7 of ~12") — `total` may not be reached exactly, and
 * nothing here uses either to decide when to stop. Do not restore the old
 * comparison; it is the defect, not a simplification.
 *
 * Wrapped end to end in try/catch — an unexpected failure marks the run
 * `failed` with a message instead of leaving it stuck `running` forever.
 */
export async function advanceSteamSyncAction(runId: string): Promise<SyncProgress | { readonly error: string }> {
  const owner = await requireOwner();

  try {
    const run = await getSyncRun(owner.userId, runId);
    if (run === null || run.status !== 'running') {
      return { error: 'Sync run not found, or not running.' };
    }

    const library = parseSteamLibrary(await getSyncRunLibrary(owner.userId, runId));
    const chunk = await listSteamGamesChunk(owner.userId, run.lastGameId, CHUNK_SIZE);

    // ONE query for the whole chunk's play-year sums, not one per game.
    const playYearSums = await sumPlayYearsForGames(
      owner.userId,
      chunk.map((game) => game.id),
    );

    const changes: PlannedChange[] = [];
    for (const game of chunk) {
      const appid = resolveAppid(game, library);
      if (appid === null) continue; // Steam does not own this game — stage nothing, move on.

      const owned = library.find((entry) => entry.appid === appid);
      const steamHoursTenths = owned ? minutesToHoursTenths(owned.playtimeMinutes) : null;
      const achievements = await fetchAchievementCounts(appid);

      const stored: StoredGameForSync = {
        id: game.id,
        title: game.title,
        steamAppid: game.steamAppid,
        hoursTenths: game.hoursTenths,
        achievementsUnlocked: game.achievementsUnlocked,
        achievementsTotal: game.achievementsTotal,
        playYearTenths: playYearSums.get(game.id) ?? null,
        lastPlayedAt: game.lastPlayedAt,
      };

      changes.push(
        ...planLinkedGameChanges(stored, appid, achievements, steamHoursTenths, owned?.lastPlayedAt ?? null),
      );
    }

    const done = chunk.length === 0;
    const newCursor = run.cursor + chunk.length;
    const lastInChunk = chunk.at(-1);
    // An empty chunk leaves the bookmark exactly where it was — there is
    // nothing new to remember it by.
    const newLastGameId = lastInChunk ? lastInChunk.id : run.lastGameId;

    await appendSyncChanges(owner.userId, runId, changes, newCursor, newLastGameId);

    if (done) {
      const allSteamGames = await listSteamGamesForMatching(owner.userId);
      const matched = matchedSteamAppids(allSteamGames, library);
      const newGameChanges = library.filter((entry) => !matched.has(entry.appid)).map(planNewGameChange);

      if (newGameChanges.length > 0) {
        await appendSyncChanges(owner.userId, runId, newGameChanges, newCursor, newLastGameId);
      }
      await finishSyncRun(owner.userId, runId, 'ready');
    }

    const changeCount = (await listSyncChanges(owner.userId, runId)).length;

    return { runId, cursor: newCursor, total: run.total, done, changeCount };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Sync failed unexpectedly.';
    await finishSyncRun(owner.userId, runId, 'failed', message);
    return { error: message };
  }
}

/**
 * `new_game` changes enriched per `advanceSyncEnrichmentAction` call. Each
 * one costs up to TWO IGDB requests (`searchGames`'s search, then its own
 * time-to-beat merge — see that function's doc comment in `igdb.ts`), so a
 * chunk of `ENRICHMENT_CHUNK_SIZE` games is at most `2 * ENRICHMENT_CHUNK_SIZE`
 * outbound requests per call. This loop is the one caller that passes
 * `searchGames(title, { paced: true })` — `igdb.ts`'s self-imposed throttle
 * (`MIN_INTERVAL_MS`, mirroring `scripts/backfill-game-metadata.mjs`'s
 * already-proven watermark) is scoped to that opt-in and is what actually
 * keeps THIS request stream under IGDB's documented 4 req/s limit, regardless
 * of chunk size — this constant exists for UI responsiveness (visible
 * progress, no single call stalling for tens of seconds), matching
 * `CHUNK_SIZE` above's own reasoning for the main sync walk.
 *
 * SEPARATE from `CHUNK_SIZE`: enrichment runs as its OWN chunked pass, after
 * a run reaches `ready`, over the fixed set of `new_game` changes it staged —
 * never folded into the `if (done)` block that stages them (see this
 * module's — and `psn-actions.ts`'s — own header on why enriching ~70+ new
 * games synchronously in one call would mean tens of seconds of serial
 * waiting in a single action).
 */
const ENRICHMENT_CHUNK_SIZE = 3;

export interface EnrichmentProgress {
  readonly runId: string;
  readonly done: boolean;
  /** How many changes THIS call processed (0 once every `new_game` change has been enriched) — not a running total. */
  readonly enrichedCount: number;
}

/**
 * Enriches up to `ENRICHMENT_CHUNK_SIZE` staged `new_game` changes for a
 * `ready` run with IGDB cover art / genre / metacritic / average playtime /
 * ESRB rating, writing the result into each change's own `payload` — so the
 * review screen (`sync-review.tsx`) can render a real cover BEFORE the owner
 * ever commits, and so `commitSyncRun` (`src/server/db/games/sync.ts`) reads
 * the same fields through into the `games` insert.
 *
 * Source-agnostic and shared by both engines — a `new_game` change looks the
 * same regardless of `run.source`, and this only ever touches
 * `game_sync_changes`, exactly like `setSyncChangeSelectedAction`/
 * `commitSyncRunAction` below (see `psn-actions.ts`'s own "NO PSN-SPECIFIC…"
 * footer for why those two live here rather than being duplicated per
 * source).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NEVER BLOCKS OR FAILS A SYNC
 *
 * `searchGames` already soft-fails to `[]` on missing credentials, a
 * Twitch/IGDB outage, a timeout, or a malformed response (`igdb.ts`'s
 * documented contract) — never a throw. `resolveNewGameMetadataFill`
 * (`metadata.ts`) turns "no suggestions" and "no HIGH-confidence match"
 * into the same empty `{}` fill, and `markNewGameChangeEnriched` marks the
 * change enriched regardless, so a game IGDB cannot confidently identify
 * simply keeps rendering as a letter-tile placeholder — exactly today's
 * behaviour before enrichment existed. There is deliberately no top-level
 * try/catch the way `advanceSteamSyncAction`/`advancePsnSyncAction` have:
 * nothing in this loop can throw except a genuine database fault, which
 * SHOULD propagate rather than be swallowed as if it were an IGDB miss.
 *
 * Idempotent by construction, not by a cursor: `listUnenrichedNewGameChanges`
 * selects only changes still missing the `metadataEnriched` marker (see its
 * own doc comment), so calling this again after `done: true` — or after a
 * client retry — is a correct, cheap no-op.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export async function advanceSyncEnrichmentAction(runId: string): Promise<EnrichmentProgress | { readonly error: string }> {
  const owner = await requireOwner();

  const run = await getSyncRun(owner.userId, runId);
  if (run === null || run.status !== 'ready') {
    return { error: 'Sync run not found, or not ready for enrichment.' };
  }

  const chunk = await listUnenrichedNewGameChanges(owner.userId, runId, ENRICHMENT_CHUNK_SIZE);

  for (const change of chunk) {
    const suggestions = await searchGames(change.title, { paced: true });
    const fill = resolveNewGameMetadataFill(change.title, suggestions);
    await markNewGameChangeEnriched(owner.userId, change.id, fill);
  }

  return { runId, done: chunk.length === 0, enrichedCount: chunk.length };
}

/**
 * Toggles the owner's own review selection on one staged change. The review
 * screen (`src/features/games/sync/sync-review.tsx`) applies this
 * optimistically and reverts on a failed `ActionResult` — same idiom as
 * Finance's `updateRowDecisionAction` in `src/features/finance/import/actions.ts`.
 */
export async function setSyncChangeSelectedAction(changeId: string, selected: boolean): Promise<ActionResult> {
  const owner = await requireOwner();
  await setSyncChangeSelected(owner.userId, changeId, selected);
  return ok();
}

/**
 * `commitSyncRunAction`'s result. Deliberately its OWN type rather than the
 * shared `ActionResult` — a successful commit has something worth telling
 * the owner beyond a bare `ok: true`: `skipped` is how many staged
 * `new_game` changes turned out to already exist (a different run beat this
 * one to creating them — see `commitSyncRun`'s own doc comment, "A STALE
 * `new_game` MUST BE SKIPPED, NOT THROWN") and were silently applied for
 * fewer games than the owner approved without this. The review screen
 * surfaces it so that never reads as "did everything I clicked."
 */
export type CommitSyncRunResult =
  | { readonly ok: true; readonly applied: number; readonly created: number; readonly skipped: number }
  | { readonly ok: false; readonly error: string };

/**
 * Applies every selected change in a run to `games` and marks the run
 * committed. `commitSyncRun`'s own expected failure modes — the run does not
 * exist (or belongs to someone else), the run was already committed, or the
 * run is not `ready` yet (still `running`, or `failed`/`cancelled`) — come
 * back as a field-free failure message, not a crash: all three are
 * expected outcomes of a button the owner can double-click or a stale tab
 * can resubmit from, not a fault in the running code. Anything else (a
 * disallowed field name reaching the whitelist check, a database fault)
 * still throws — see `action-result.ts`'s own doc comment on that split,
 * which this action follows even though it returns `CommitSyncRunResult`,
 * not `ActionResult` itself.
 */
export async function commitSyncRunAction(runId: string): Promise<CommitSyncRunResult> {
  const owner = await requireOwner();

  let result: { readonly applied: number; readonly created: number; readonly skipped: number };
  try {
    result = await commitSyncRun(owner.userId, runId);
  } catch (error) {
    if (error instanceof SyncRunNotFoundError) return { ok: false, error: error.message };
    if (error instanceof SyncRunAlreadyCommittedError) return { ok: false, error: error.message };
    if (error instanceof SyncRunNotReadyError) return { ok: false, error: error.message };
    throw error;
  }

  // 'layout' covers both Games tab routes in one call — see the matching
  // comment in `src/features/games/game-actions.ts`.
  revalidatePath('/games', 'layout');
  return { ok: true, applied: result.applied, created: result.created, skipped: result.skipped };
}
