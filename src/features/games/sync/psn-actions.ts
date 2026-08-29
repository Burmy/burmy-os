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
import { replaceGameTrophies } from '@/server/db/games/trophies';
import { countPsnGames, listPsnGamesChunk, listPsnGamesForMatching } from '@/server/db/games/games';
import { sumPlayYearsForGames } from '@/server/db/games/play-years';
import {
  currentPsnTokenFingerprint,
  fetchGameTrophies,
  fetchPlayedTitles,
  fetchTrophyTitles,
  psnConfigured,
} from '@/server/db/games/psn-client';
import {
  appendSyncChanges,
  createSyncRun,
  finishSyncRun,
  getPsnTokenInUseSince,
  getSyncRun,
  getSyncRunLibrary,
  listSyncChanges,
} from '@/server/db/games/sync';
import { npServiceNameForPlatform } from '@/server/games/psn';
import type { PsnPlayedTitle, PsnTrophyTitle } from '@/server/games/psn';
import {
  dedupePlayedTitles,
  planCollectionMemberTrophyChanges,
  planLinkedPsnGameChanges,
  resolvePlayedTitle,
  resolvePsnSyncTargets,
  resolveTrophyTitle,
  planNewPsnGameChange,
  type StoredGameForPsnSync,
} from '@/server/games/psn-plan';
import { psnTokenAge, type PsnTokenAge } from '@/server/games/psn-token-age';
import type { PlannedChange } from '@/server/games/sync-plan';
import type { GamePlatform } from '@/server/games/taxonomy';

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
 * `startPsnSyncAction`'s result. Failure carries both a ready-to-display
 * `error` message AND the structured `reason` it came from — the message is
 * for the toast (`psn-sync-button.tsx`'s existing "never collapsed into one
 * generic blob" path), and `reason` is what lets the button additionally
 * switch to a PERSISTENT notice for `'token_expired'` (see that component's
 * own doc comment): a toast alone cannot carry the clickable Sony retrieval
 * link this reason needs, since it disappears after a few seconds.
 */
export type PsnSyncStartResult =
  | { readonly ok: true; readonly runId: string }
  | { readonly ok: false; readonly error: string; readonly reason: 'not_configured' | 'token_expired' | 'unavailable' };

function psnStartFailure(reason: 'not_configured' | 'token_expired' | 'unavailable'): PsnSyncStartResult {
  const error =
    reason === 'not_configured'
      ? 'PlayStation is not configured — set PSN_NPSSO to sync.'
      : reason === 'token_expired'
        ? PSN_TOKEN_EXPIRED_MESSAGE
        : 'PlayStation did not respond. Try again in a moment.';
  return { ok: false, error, reason };
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
 *
 * `currentPsnTokenFingerprint()` is read and stored on the new run ONLY
 * here, after both fetches have already succeeded — recording "this token
 * actually worked," never merely "this token was configured." See
 * `psn-client.ts`'s doc comment on the fingerprint itself.
 *
 * `dedupePlayedTitles` (`psn-plan.ts`) runs exactly ONCE here, before the
 * snapshot is ever persisted — see that function's own doc comment for why
 * PSN legitimately returns the same real game more than once (Ghost of
 * Tsushima, three times, on the owner's real account) and why undeduped
 * data staged a `new_game` change per variant that then collided at commit.
 * Every later reader of this run's snapshot (the per-chunk matching loop,
 * the end-of-run new-game sweep) sees only the deduped list — there is
 * nothing left for them to dedupe themselves.
 */
export async function startPsnSyncAction(): Promise<PsnSyncStartResult> {
  const owner = await requireOwner();

  const rawPlayedTitles = await fetchPlayedTitles();
  if (rawPlayedTitles === 'not_configured' || rawPlayedTitles === 'token_expired' || rawPlayedTitles === 'unavailable') {
    return psnStartFailure(rawPlayedTitles);
  }

  const trophyTitles = await fetchTrophyTitles();
  if (trophyTitles === 'not_configured' || trophyTitles === 'token_expired' || trophyTitles === 'unavailable') {
    return psnStartFailure(trophyTitles);
  }

  const playedTitles = dedupePlayedTitles(rawPlayedTitles);

  const total = await countPsnGames(owner.userId);
  const snapshot: PsnSnapshot = { playedTitles, trophyTitles };
  const fingerprint = currentPsnTokenFingerprint();
  const run = await createSyncRun(owner.userId, 'psn', total, snapshot, fingerprint ?? undefined);

  return { ok: true, runId: run.id };
}

/**
 * PSN token age for the Library screen's status line — see
 * `psnTokenAge`'s own doc comment in `src/server/games/psn-token-age.ts`
 * for the classification itself. `'unknown'` immediately, with no query at
 * all, when `PSN_NPSSO` is unset; otherwise looked up via
 * `getPsnTokenInUseSince`, which naturally returns `null` (also
 * `'unknown'`) for a token that has never yet completed a successful sync.
 */
export async function getPsnTokenAgeAction(): Promise<PsnTokenAge> {
  const owner = await requireOwner();

  const fingerprint = currentPsnTokenFingerprint();
  if (fingerprint === null) return { status: 'unknown', ageDays: null };

  const inUseSince = await getPsnTokenInUseSince(owner.userId, fingerprint);
  return psnTokenAge(inUseSince);
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
      // ─────────────────────────────────────────────────────────────────────
      // A COLLECTION MEMBER IS TROPHY-ONLY, AND NEVER REACHES A NAME MATCH.
      //
      // It is in this chunk at all only because it carries its own
      // `psnNpCommunicationId` (see `PSN_SYNC_SCOPE`). Skipping
      // `resolvePlayedTitle` for it is what keeps the original blindness rule
      // intact: with no played title there is no hours, platform or
      // lastPlayedAt value in existence to propose, so the SET's play time
      // cannot be written onto one of its titles and counted twice.
      // ─────────────────────────────────────────────────────────────────────
      const targets = resolvePsnSyncTargets(game, playedTitles, trophyTitles);
      if (targets === null) continue; // PSN has nothing for this game — stage nothing, move on.
      const { played, trophy } = targets;

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

      changes.push(
        ...(played === null
          ? planCollectionMemberTrophyChanges(stored, trophy)
          : planLinkedPsnGameChanges(stored, played, trophy)),
      );

      // ─────────────────────────────────────────────────────────────────────
      // TROPHIES ARE WRITTEN HERE, DIRECTLY — NOT STAGED AS A PROPOSED CHANGE.
      //
      // Everything above this line goes into `changes` for the owner to review
      // and approve, because every field it touches (hours, achievement counts,
      // platinum) is one the owner can type themselves, so a sync can only ever
      // PROPOSE a correction to it. An individual earned trophy is not that: it
      // is a fact about the past with no owner-authored counterpart, and asking
      // for approval would be asking them to ratify reality.
      //
      // This is the +1 request per game (~74) that makes a full PSN sync
      // noticeably slower, accepted deliberately in exchange for a game page
      // that renders trophies instantly and for cross-game trophy queries
      // existing at all.
      //
      // Failure is soft and per-game: `fetchGameTrophies` returns a
      // `PsnFailure` string rather than throwing, and `replaceGameTrophies`
      // ignores an empty set, so one game's trophy list failing to load leaves
      // its stored rows untouched and never derails the run.
      // ─────────────────────────────────────────────────────────────────────
      if (game.psnNpCommunicationId !== null) {
        const fetched = await fetchGameTrophies(game.psnNpCommunicationId, npServiceNameForPlatform(game.platform));
        if (typeof fetched !== 'string') {
          await replaceGameTrophies(owner.userId, game.id, 'psn', fetched);
        }
      }
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
// codebase to avoid. Staging (`startPsnSyncAction`/`advancePsnSyncAction`
// above) and token-fingerprint tracking (`getPsnTokenAgeAction`, also
// above) are genuinely PSN-specific — Steam has no NPSSO-style expiring
// credential, so there is nothing for `sync-actions.ts` to share here.
// ─────────────────────────────────────────────────────────────────────────────
