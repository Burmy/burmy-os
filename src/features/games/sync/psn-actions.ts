'use server';

/**
 * The chunked PSN sync engine. Mirrors `sync-actions.ts` (the Steam engine)
 * deliberately — same keyset pagination, same `CHUNK_SIZE`, same "done is an
 * empty chunk" rule, same `finishSyncRun('failed', …)` on an unexpected
 * error — and REUSES its staging/review/commit machinery wholesale: this
 * module only ever calls `appendSyncChanges`/`finishSyncRun` against
 * `game_sync_runs`/`game_sync_changes` (with `source: 'psn'`), never a
 * second staging table or a second review screen.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE NO-DELETE INVARIANT (SAME GUARANTEE AS STEAM'S, PROVEN FOR PSP TOO)
 *
 * A PlayStation-platform library game PSN's response does not account for is
 * skipped and left completely untouched — no write of any kind reaches its
 * row. This module never calls `createGame`/`updateGame`/`deleteGame` at
 * all, only read functions plus the sync-staging functions. PSP games are
 * WALKED like any other PlayStation-platform game (`listPsnGamesChunk`
 * covers `ps5`/`ps4`/`psp` — see that function's own doc comment for why PSP
 * is deliberately not filtered out as an "optimisation").
 *
 * PSN itself never returns a title that is GENUINELY a PSP game (its trophy
 * system postdates the PSP entirely) — but that alone is NOT sufficient to
 * keep a PSP row untouched, because Sony has re-released several PSP-era
 * titles on PS4/PS5 under the IDENTICAL name (e.g. "Persona 3 Portable"). A
 * plain name match has no way to tell the owner's real PSP copy apart from
 * that unrelated re-release, so `resolvePlayedTitle` carries an EXPLICIT
 * guard: an unlinked (`psnTitleId === null`) `platform === 'psp'` row skips
 * the name-match fallback entirely and always resolves to `null`. Only that
 * guard — not the absence of PSP titles in PSN's response by itself — is
 * what makes every PSP row stage nothing and stay byte-identical. See
 * `tests/integration/games-psn-actions.test.ts`'s two named tests: the
 * unrelated-response invariant test (mutation-tested) and the same-titled
 * re-release collision test.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO IDENTIFIER SPACES, RESOLVED INDEPENDENTLY — STORED VALUE ALWAYS WINS
 * OVER A FRESH MATCH
 *
 * `titleId` (played-game data) and `npCommunicationId` (trophy data) do not
 * join except by name (`src/server/games/psn.ts`'s module header). This
 * engine resolves each independently, and for EACH one applies the same
 * controller invariant `sync-actions.ts`'s `resolveAppid` documents for
 * Steam: once a game is already linked, the STORED identifier is what gets
 * looked up in this run's snapshot — never a freshly re-matched one. Only a
 * game with no stored `psnTitleId` (or no stored `psnNpCommunicationId`) at
 * all falls through to `bestTitleMatchAmong`, which enforces
 * `SIMILARITY_FLOOR` and is never bypassed or lowered here.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { requireOwner } from '@/server/auth/owner';
import { countPsnGames, listPsnGamesChunk, listPsnGamesForMatching } from '@/server/db/games/games';
import { sumPlayYearsForGames } from '@/server/db/games/play-years';
import { fetchPlayedTitles, fetchTrophyTitles, psnConfigured } from '@/server/db/games/psn-client';
import {
  appendSyncChanges,
  createSyncRun,
  finishSyncRun,
  getSyncRun,
  getSyncRunLibrary,
  listSyncChanges,
} from '@/server/db/games/sync';
import { bestTitleMatchAmong } from '@/server/games/metadata';
import type { PsnPlayedTitle, PsnTrophyTitle } from '@/server/games/psn';
import { planLinkedPsnGameChanges, planNewPsnGameChange, type StoredGameForPsnSync } from '@/server/games/psn-plan';
import type { PlannedChange } from '@/server/games/sync-plan';
import type { GamePlatform } from '@/server/games/taxonomy';
import { type ActionResult, fail } from '../action-result';

/**
 * Library games processed per `advancePsnSyncAction` call. Identical to
 * Steam's `CHUNK_SIZE` — kept the same value deliberately so the two engines
 * behave the same way for the owner even though PSN's per-game matching is
 * pure/local (no extra HTTP request per game the way Steam's achievement
 * fetch is): staying chunked keeps progress visibly live and keeps every
 * call comfortably inside a serverless timeout regardless.
 */
const CHUNK_SIZE = 5;

/**
 * The one message shown for a `'token_expired'` result, from either
 * `fetchPlayedTitles` or `fetchTrophyTitles` — distinct from both
 * `'not_configured'` ("set PSN_NPSSO") and `'unavailable'` ("try again"),
 * per `psn-client.ts`'s three-way failure contract. Names the cadence (the
 * NPSSO expires roughly every two months and there is no way to detect that
 * without actually calling Sony — see `psnConfigured()`'s own doc comment)
 * and the exact retrieval URL, because "something went wrong" here gives
 * the owner no way to know a fresh token is the fix.
 */
const PSN_TOKEN_EXPIRED_MESSAGE =
  'Your PlayStation token expired (this happens roughly every two months) — get a new one from ' +
  'https://ca.account.sony.com/api/v1/ssocookie while logged in to PlayStation, then set PSN_NPSSO.';

// The "412 new games" volume warning for a large `new_game` count is a
// REVIEW-SCREEN concern, not a staging one — its threshold lives in
// `sync-review.tsx` itself, not here. (A `'use server'` file may only export
// async functions; a plain numeric constant would not even be legal here.)

export interface PsnSyncProgress {
  readonly runId: string;
  readonly cursor: number;
  readonly total: number;
  readonly done: boolean;
  readonly changeCount: number;
}

interface PsnSnapshot {
  readonly playedTitles: readonly PsnPlayedTitle[];
  readonly trophyTitles: readonly PsnTrophyTitle[];
}

/**
 * Defensively narrows the run's stored PSN snapshot back into typed arrays.
 * `getSyncRunLibrary` returns `unknown` on purpose (see its own doc comment
 * in `src/server/db/games/sync.ts`) — this is a stored third-party snapshot,
 * not a typed contract — so a malformed or missing entry degrades to an
 * empty array rather than throwing, the same discipline `parseSteamLibrary`
 * applies on the Steam side.
 */
function parsePsnSnapshot(value: unknown): PsnSnapshot {
  if (typeof value !== 'object' || value === null) return { playedTitles: [], trophyTitles: [] };
  const record = value as Record<string, unknown>;

  return {
    playedTitles: Array.isArray(record.playedTitles) ? (record.playedTitles as PsnPlayedTitle[]) : [],
    trophyTitles: Array.isArray(record.trophyTitles) ? (record.trophyTitles as PsnTrophyTitle[]) : [],
  };
}

/**
 * The played title this stored game resolves to against the run's snapshot,
 * or `null` when PSN does not own it. See the module header — STORED
 * `psnTitleId` always wins over a fresh match when present.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AN UNLINKED PSP ROW NEVER FALLS THROUGH TO THE NAME MATCH
 *
 * `categoryToPlatform` (`src/server/games/psn.ts`) can never legitimately
 * resolve `'psp'` — PSN's trophy system postdates the PSP entirely, so no
 * response it returns is genuinely a PSP title. That means an UNLINKED
 * `platform === 'psp'` row can never have a real fresh match in PSN's
 * played-titles list — any name match it scores is necessarily a
 * COINCIDENCE, not a real link. Sony has re-released several PSP-era games
 * (e.g. "Persona 3 Portable") on PS4/PS5 under the IDENTICAL title, so
 * without this guard a plain name match against the whole list would
 * confidently — and wrongly — link the PSP row to that unrelated PS4/PS5
 * release, staging a `platform` flip straight through the very column
 * `categoryToPlatform` was hardened to protect. This is checked HERE,
 * before the fallback runs, rather than by filtering `playedTitles` by
 * platform for every game: doing it here keeps ps4/ps5 matching completely
 * unchanged and makes the PSP case a single, auditable early return. See
 * `tests/integration/games-psn-actions.test.ts`'s named collision test.
 * ─────────────────────────────────────────────────────────────────────────────
 */
function resolvePlayedTitle(
  game: { readonly title: string; readonly platform: GamePlatform; readonly psnTitleId: string | null },
  playedTitles: readonly PsnPlayedTitle[],
): PsnPlayedTitle | null {
  if (game.psnTitleId !== null) {
    return playedTitles.find((entry) => entry.titleId === game.psnTitleId) ?? null;
  }
  if (game.platform === 'psp') return null;
  return bestTitleMatchAmong(game.title, playedTitles, (entry) => entry.name)?.candidate ?? null;
}

/**
 * The trophy title this stored game resolves to, or `null` when no
 * confident match exists. STORED `psnNpCommunicationId` always wins over a
 * fresh match when present; otherwise the match is BY NAME against the
 * resolved played title's own name (PSN's own naming, more likely to agree
 * with its trophy list than the owner's possibly-edited stored title) —
 * falling back to the stored title only when no played title resolved at
 * all. `bestTitleMatchAmong`'s `SIMILARITY_FLOOR` is never bypassed.
 */
function resolveTrophyTitle(
  game: { readonly title: string; readonly psnNpCommunicationId: string | null },
  playedTitle: PsnPlayedTitle | null,
  trophyTitles: readonly PsnTrophyTitle[],
): PsnTrophyTitle | null {
  if (game.psnNpCommunicationId !== null) {
    return trophyTitles.find((entry) => entry.npCommunicationId === game.psnNpCommunicationId) ?? null;
  }
  const nameToMatch = playedTitle?.name ?? game.title;
  return bestTitleMatchAmong(nameToMatch, trophyTitles, (entry) => entry.name)?.candidate ?? null;
}

/**
 * Every `titleId` already accounted for by a library game — either linked
 * already or matched by title right now. Recomputed fresh from EVERY one of
 * the owner's PlayStation-platform games, exactly like Steam's
 * `matchedSteamAppids` — staging never writes to `games`, so a title match
 * staged several chunks ago is still invisible in the `psnTitleId` column.
 *
 * Delegates to `resolvePlayedTitle`, so an unlinked PSP row is subject to
 * the SAME "never name-match" guard here as in the per-chunk loop — without
 * it, a PSP row could silently "claim" a same-titled PS4/PS5 played title
 * for the purposes of this set, which would then hide that title's own
 * `new_game` change even though `resolvePlayedTitle` correctly refused to
 * stage anything against the PSP row itself. `storedGames` therefore needs
 * `platform`, not just `title`/`psnTitleId`.
 */
function matchedPsnTitleIds(
  storedGames: readonly { readonly title: string; readonly platform: GamePlatform; readonly psnTitleId: string | null }[],
  playedTitles: readonly PsnPlayedTitle[],
): Set<string> {
  const matched = new Set<string>();
  for (const game of storedGames) {
    const played = resolvePlayedTitle(game, playedTitles);
    if (played !== null) matched.add(played.titleId);
  }
  return matched;
}

/** Whether PSN is configured, for the UI to decide whether to offer the sync entry point at all. */
export async function isPsnConfiguredAction(): Promise<boolean> {
  await requireOwner();
  return psnConfigured();
}

/**
 * Starts a run: fetches the owner's full PSN played-titles and trophy-titles
 * lists ONCE, snapshots them together, and creates a `game_sync_runs` row
 * (`source: 'psn'`) covering every PlayStation-platform library game.
 *
 * Never throws. `psn-client.ts`'s three-way failure contract
 * (`'not_configured' | 'token_expired' | 'unavailable'`) is surfaced as a
 * distinct, actionable message for each — collapsing them into one generic
 * "sync failed" would erase exactly the distinction the owner needs ("paste
 * a new NPSSO" is not the same instruction as "try again later").
 */
export async function startPsnSyncAction(): Promise<ActionResult & { readonly runId?: string }> {
  const owner = await requireOwner();

  const playedTitles = await fetchPlayedTitles();
  if (playedTitles === 'not_configured') {
    return fail('PlayStation is not configured — set PSN_NPSSO to sync.');
  }
  if (playedTitles === 'token_expired') {
    return fail(PSN_TOKEN_EXPIRED_MESSAGE);
  }
  if (playedTitles === 'unavailable') {
    return fail('PlayStation did not respond. Try again in a moment.');
  }

  const trophyTitles = await fetchTrophyTitles();
  if (trophyTitles === 'not_configured') {
    return fail('PlayStation is not configured — set PSN_NPSSO to sync.');
  }
  if (trophyTitles === 'token_expired') {
    return fail(PSN_TOKEN_EXPIRED_MESSAGE);
  }
  if (trophyTitles === 'unavailable') {
    return fail('PlayStation did not respond. Try again in a moment.');
  }

  const total = await countPsnGames(owner.userId);
  const snapshot: PsnSnapshot = { playedTitles, trophyTitles };
  const run = await createSyncRun(owner.userId, 'psn', total, snapshot);

  return { ok: true, runId: run.id };
}

/**
 * Processes one chunk of a running PSN sync: matches up to `CHUNK_SIZE`
 * PlayStation-platform library games against the run's snapshot, stages the
 * resulting changes, and advances the keyset bookmark. On the chunk that
 * comes back EMPTY, also stages a `new_game` change for every PSN played
 * title no library row accounts for, then marks the run `ready`.
 *
 * "Done" is an empty chunk, never `cursor >= total` — identical reasoning to
 * `advanceSteamSyncAction`'s own doc comment in `sync-actions.ts` (a random
 * UUID `id`, not a monotonic sequence, paired with a `total` snapshot taken
 * once at run creation). Do not restore an offset/total comparison here.
 *
 * Wrapped end to end in try/catch — an unexpected failure marks the run
 * `failed` with a message instead of leaving it stuck `running` forever.
 */
export async function advancePsnSyncAction(runId: string): Promise<PsnSyncProgress | { readonly error: string }> {
  const owner = await requireOwner();

  try {
    const run = await getSyncRun(owner.userId, runId);
    if (run === null || run.status !== 'running') {
      return { error: 'Sync run not found, or not running.' };
    }

    const { playedTitles, trophyTitles } = parsePsnSnapshot(await getSyncRunLibrary(owner.userId, runId));
    const chunk = await listPsnGamesChunk(owner.userId, run.lastGameId, CHUNK_SIZE);

    // ONE query for the whole chunk's play-year sums, not one per game.
    const playYearSums = await sumPlayYearsForGames(
      owner.userId,
      chunk.map((game) => game.id),
    );

    const changes: PlannedChange[] = [];
    for (const game of chunk) {
      const played = resolvePlayedTitle(game, playedTitles);
      if (played === null) continue; // PSN does not own this game — stage nothing, move on.

      const trophy = resolveTrophyTitle(game, played, trophyTitles);

      const stored: StoredGameForPsnSync = {
        id: game.id,
        title: game.title,
        platform: game.platform,
        psnTitleId: game.psnTitleId,
        psnNpCommunicationId: game.psnNpCommunicationId,
        hoursTenths: game.hoursTenths,
        firstPlayedYear: game.firstPlayedYear,
        lastPlayedAt: game.lastPlayedAt,
        achievementsUnlocked: game.achievementsUnlocked,
        achievementsTotal: game.achievementsTotal,
        platinum: game.platinum,
        playYearTenths: playYearSums.get(game.id) ?? null,
      };

      changes.push(...planLinkedPsnGameChanges(stored, played, trophy));
    }

    const done = chunk.length === 0;
    const newCursor = run.cursor + chunk.length;
    const lastInChunk = chunk.at(-1);
    const newLastGameId = lastInChunk ? lastInChunk.id : run.lastGameId;

    await appendSyncChanges(owner.userId, runId, changes, newCursor, newLastGameId);

    if (done) {
      const allPsnGames = await listPsnGamesForMatching(owner.userId);
      const matched = matchedPsnTitleIds(allPsnGames, playedTitles);
      const newGameChanges = playedTitles
        .filter((title) => !matched.has(title.titleId))
        .map((title) => planNewPsnGameChange(title, resolveTrophyTitle({ title: title.name, psnNpCommunicationId: null }, title, trophyTitles)));

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

// ─────────────────────────────────────────────────────────────────────────────
// NO PSN-SPECIFIC SELECT/COMMIT ACTIONS HERE, DELIBERATELY
//
// `setSyncChangeSelectedAction`/`commitSyncRunAction` (`./sync-actions.ts`)
// already delegate to `setSyncChangeSelected`/`commitSyncRun`
// (`src/server/db/games/sync.ts`), and neither of those data-access
// functions reads or branches on a run's `source` at all — they operate on
// `runId`/`changeId` alone, scoped by `ownerId`. A PSN run's review screen
// reuses those two Server Actions completely unchanged; adding PSN-named
// duplicates here would be a second copy of logic with nothing PSN-specific
// in it, exactly the kind of speculative abstraction CLAUDE.md asks this
// codebase to avoid. Only staging (`startPsnSyncAction`/
// `advancePsnSyncAction` above) is genuinely PSN-specific.
// ─────────────────────────────────────────────────────────────────────────────
