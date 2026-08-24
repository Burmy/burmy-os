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
import { SyncRunAlreadyCommittedError, SyncRunNotFoundError } from '@/server/db/games/errors';
import { countSteamGames, listSteamGamesChunk, listSteamGamesForMatching } from '@/server/db/games/games';
import { sumPlayYearsForGames } from '@/server/db/games/play-years';
import {
  appendSyncChanges,
  commitSyncRun,
  createSyncRun,
  finishSyncRun,
  getSyncRun,
  getSyncRunLibrary,
  listSyncChanges,
  setSyncChangeSelected,
} from '@/server/db/games/sync';
import { fetchAchievementCounts, fetchOwnedGames } from '@/server/db/games/steam-client';
import { minutesToHoursTenths } from '@/server/games/hours';
import { bestTitleMatchAmong } from '@/server/games/metadata';
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
    const { appid, name, playtimeMinutes } = record;
    if (typeof appid !== 'number' || typeof name !== 'string' || typeof playtimeMinutes !== 'number') return [];
    return [{ appid, name, playtimeMinutes }];
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
      };

      changes.push(...planLinkedGameChanges(stored, appid, achievements, steamHoursTenths));
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
 * Applies every selected change in a run to `games` and marks the run
 * committed. `commitSyncRun`'s own two failure modes — the run does not
 * exist (or belongs to someone else) and the run was already committed —
 * come back as a field-free `ActionResult` message, not a crash: both are
 * expected outcomes of a button the owner can double-click or a stale tab
 * can resubmit from, not a fault in the running code. Anything else (a
 * disallowed field name reaching the whitelist check, a database fault)
 * still throws — see `action-result.ts`'s own doc comment on that split.
 */
export async function commitSyncRunAction(runId: string): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    await commitSyncRun(owner.userId, runId);
  } catch (error) {
    if (error instanceof SyncRunNotFoundError) return fail(error.message);
    if (error instanceof SyncRunAlreadyCommittedError) return fail(error.message);
    throw error;
  }

  // 'layout' covers both Games tab routes in one call — see the matching
  // comment in `src/features/games/game-actions.ts`.
  revalidatePath('/games', 'layout');
  return ok();
}
