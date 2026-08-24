'use server';

/**
 * The chunked Steam sync engine.
 *
 * Walks the owner's Steam-platform library in small pages, matches each game
 * against a ONE-TIME snapshot of the owner's Steam library, and STAGES the
 * resulting changes for review — nothing here ever writes to `games`. The
 * review screen that reads and applies staged changes is a later task; this
 * module only produces `game_sync_changes` rows via
 * `src/server/db/games/sync.ts`.
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

import { requireOwner } from '@/server/auth/owner';
import { countSteamGames, listSteamGamesChunk, listSteamGamesForMatching } from '@/server/db/games/games';
import { sumPlayYearsForGames } from '@/server/db/games/play-years';
import {
  appendSyncChanges,
  createSyncRun,
  finishSyncRun,
  getSyncRun,
  getSyncRunLibrary,
  listSyncChanges,
} from '@/server/db/games/sync';
import { fetchAchievementCounts, fetchOwnedGames } from '@/server/db/games/steam-client';
import { minutesToHoursTenths } from '@/server/games/hours';
import { bestTitleMatchAmong } from '@/server/games/metadata';
import type { OwnedSteamGame } from '@/server/games/steam';
import { planLinkedGameChanges, planNewGameChange, type PlannedChange, type StoredGameForSync } from '@/server/games/sync-plan';
import { type ActionResult, fail } from '../action-result';

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

/** Whether Steam credentials are configured, for the UI to decide whether to offer the sync entry point at all. */
export async function isSteamConfiguredAction(): Promise<boolean> {
  await requireOwner();
  const apiKey = process.env.STEAM_API_KEY;
  const steamId = process.env.STEAM_ID;
  return apiKey !== undefined && apiKey !== '' && steamId !== undefined && steamId !== '';
}

/**
 * Starts a run: fetches the owner's Steam library ONCE, snapshots it, and
 * creates a `game_sync_runs` row covering every Steam-platform library game.
 *
 * Never throws on a Steam failure. `fetchOwnedGames()` returning `null`
 * means credentials are missing or the request itself failed — both are
 * normal, reportable states (see the soft-failure contract documented in
 * `src/server/db/games/steam-client.ts`), not a crash.
 */
export async function startSteamSyncAction(): Promise<ActionResult & { readonly runId?: string }> {
  const owner = await requireOwner();

  const library = await fetchOwnedGames();
  if (library === null) {
    return fail('Steam is not configured, or did not respond.');
  }

  const total = await countSteamGames(owner.userId);
  const run = await createSyncRun(owner.userId, 'steam', total, library);

  return { ok: true, runId: run.id };
}

/**
 * Processes one chunk of a running sync: matches up to `CHUNK_SIZE` library
 * games against the run's Steam snapshot, stages the resulting changes, and
 * advances the cursor. On the chunk that reaches `total`, also stages a
 * `new_game` change for every Steam-owned game no library row accounts for,
 * then marks the run `ready`.
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
    const chunk = await listSteamGamesChunk(owner.userId, run.cursor, CHUNK_SIZE);

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

    const newCursor = run.cursor + chunk.length;
    await appendSyncChanges(owner.userId, runId, changes, newCursor);

    const done = newCursor >= run.total;
    if (done) {
      const allSteamGames = await listSteamGamesForMatching(owner.userId);
      const matched = matchedSteamAppids(allSteamGames, library);
      const newGameChanges = library.filter((entry) => !matched.has(entry.appid)).map(planNewGameChange);

      if (newGameChanges.length > 0) {
        await appendSyncChanges(owner.userId, runId, newGameChanges, newCursor);
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
