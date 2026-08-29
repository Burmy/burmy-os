'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { type ActionResult, fail, ok } from '@/features/anime/action-result';
import { requireOwner } from '@/server/auth/owner';
import type { AniListEntry } from '@/server/anime/anilist';
import { bestTitleMatch } from '@/server/anime/matching';
import { groupRelatedMedia, seriesIdentityFor, suggestSeriesTitle } from '@/server/anime/series';
import {
  type PlannedAnimeChange,
  planLinkedAnimeChanges,
  planNewAnimeChange,
  planSeriesHint,
} from '@/server/anime/sync-plan';
import { anilistConfigured, fetchActivities, fetchAnimeList } from '@/server/db/anime/anilist-client';
import {
  countAnime,
  listAnilistIdMap,
  listAnimeChunk,
  listLinkedAnilistIds,
  listSeriesMembership,
} from '@/server/db/anime/anime';
import { insertWatchLogEntries } from '@/server/db/anime/watch-log';
import {
  AnimeSyncRunAlreadyCommittedError,
  AnimeSyncRunNotFoundError,
  AnimeSyncRunNotReadyError,
} from '@/server/db/anime/errors';
import {
  appendAnimeSyncChanges,
  commitAnimeSyncRun,
  createAnimeSyncRun,
  finishAnimeSyncRun,
  getAnimeSyncRun,
  getAnimeSyncSnapshot,
  getLastAnimeSyncTime,
  setAnimeSyncChangeSelected,
} from '@/server/db/anime/sync';

const idSchema = z.string().uuid();

/**
 * ONE CHUNK PERFORMS ZERO OUTBOUND REQUESTS, which is why this is 50 and not
 * Games' 5.
 *
 * Steam's chunk is small because every game in it costs a
 * `GetPlayerAchievements` call, so a chunk is a burst of network traffic. The
 * whole AniList list is already in the run's snapshot by the time the walk
 * starts — a chunk here is a database page and some comparisons. Do not
 * "align" this with the Games engine; the constant means something different.
 */
const CHUNK_SIZE = 50;

export interface AnimeSyncProgress {
  readonly cursor: number;
  readonly total: number;
  readonly done: boolean;
}

/**
 * Whether AniList is configured, answered from the environment.
 *
 * Its own action because server-only env vars are unreadable from a Client
 * Component, and because the answer must NEVER be inferred from a fetch
 * result — `[]` cannot tell "not configured" apart from "empty library". Same
 * rule as `isSteamConfiguredAction` and `isPsnConfiguredAction`.
 */
export async function isAnilistConfiguredAction(): Promise<boolean> {
  await requireOwner();
  return anilistConfigured();
}

/** When AniList was last read successfully, for the Settings row's status line. */
export async function getAnimeLastSyncedAtAction(): Promise<Date | null> {
  const owner = await requireOwner();
  return getLastAnimeSyncTime(owner.userId);
}

/**
 * Starts a run: fetch the list ONCE, snapshot it, and let the walk match
 * against the snapshot rather than re-fetching per chunk.
 */
export async function startAnimeSyncAction(): Promise<ActionResult & { runId?: string }> {
  const owner = await requireOwner();

  // Checked FIRST and explicitly — see `isAnilistConfiguredAction`.
  if (!anilistConfigured()) {
    return fail('AniList is not configured. Set ANILIST_USERNAME to your AniList username.');
  }

  const list = await fetchAnimeList();
  if (list === null) {
    return fail('Could not reach AniList. It may be rate-limiting or your profile may not be public.');
  }

  const total = await countAnime(owner.userId);
  const runId = await createAnimeSyncRun(owner.userId, total, { entries: list });

  revalidatePath('/anime', 'layout');
  return { ...ok(), runId };
}

/** Re-narrows the stored snapshot. Stored third-party JSON is trusted no more than a live response. */
function entriesFromSnapshot(snapshot: unknown): AniListEntry[] {
  if (typeof snapshot !== 'object' || snapshot === null) return [];
  const entries = (snapshot as { entries?: unknown }).entries;
  return Array.isArray(entries) ? (entries as AniListEntry[]) : [];
}

/**
 * Walks one chunk of the library and stages what diverges.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DONE IS AN EMPTY CHUNK, NEVER `cursor >= total`.
 *
 * `total` is a count taken once at run creation — a snapshot, not a live value.
 * Pairing it with the walk has two failure modes the Games engine reproduced
 * against real Postgres: deleting a not-yet-processed row makes the cursor
 * converge just short of `total` and never reach it, stranding the run in
 * `running` forever; and inserting a row whose random UUID sorts earlier shifts
 * a later page backward and re-stages an already-processed row.
 *
 * `cursor` and `total` survive for progress display only ("47 of ~203"). Do not
 * restore the comparison — it is the defect, not a simplification.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export async function advanceAnimeSyncAction(
  runId: string,
): Promise<AnimeSyncProgress | { readonly error: string }> {
  const owner = await requireOwner();

  try {
    const id = idSchema.parse(runId);
    const run = await getAnimeSyncRun(owner.userId, id);
    if (run === null) return { error: 'That sync run no longer exists.' };
    if (run.status !== 'running') return { cursor: run.cursor, total: run.total, done: true };

    const entries = entriesFromSnapshot(await getAnimeSyncSnapshot(owner.userId, id));
    const byMediaId = new Map(entries.map((entry) => [entry.mediaId, entry]));

    const chunk = await listAnimeChunk(owner.userId, run.lastAnimeId, CHUNK_SIZE);

    // Media ids some row already owns. An unlinked row must never be matched
    // onto one of these: `anime_owner_anilist_id_idx` is unique, so two rows
    // pointing at the same entry is a `23505` at commit time — and even if it
    // were allowed, the second row would then be fed another show's progress.
    const claimed = await listLinkedAnilistIds(owner.userId);

    // Entries still available to match against, computed once per chunk.
    const unclaimed = entries.filter((entry) => !claimed.has(entry.mediaId));

    const changes: PlannedAnimeChange[] = [];
    for (const row of chunk) {
      if (row.anilistMediaId === null) {
        // A HAND-ADDED SHOW. It has no AniList id, so the only way in is the
        // title — see `matching.ts` for why that matcher is far stricter than
        // the Games one, and why a wrong link here would be data loss rather
        // than a wrong cover.
        const match = bestTitleMatch(row.title, unclaimed);
        if (match === null) continue;

        // Claim it within this walk too. Two hand-added rows with the same
        // title would otherwise both match the same entry, and the second
        // link would fail at commit.
        claimed.add(match.entry.mediaId);
        changes.push(...planLinkedAnimeChanges(row, match.entry));
        continue;
      }

      const entry = byMediaId.get(row.anilistMediaId);
      if (entry === undefined) continue; // AniList no longer lists it — leave the row completely alone.

      changes.push(...planLinkedAnimeChanges(row, entry));
    }

    const done = chunk.length === 0;
    const lastInChunk = chunk.at(-1);

    await appendAnimeSyncChanges(
      owner.userId,
      id,
      changes,
      run.cursor + chunk.length,
      lastInChunk ? lastInChunk.id : run.lastAnimeId,
    );

    if (done) {
      // Re-read rather than tracking during the walk: staging never writes to
      // `anime`, so a `link` staged three chunks ago is still invisible in the
      // column.
      const linked = await listLinkedAnilistIds(owner.userId);
      const newChanges = entries
        .filter((entry) => !linked.has(entry.mediaId))
        .map((entry) => planNewAnimeChange(entry));

      const hints = await planSeriesHints(
        owner.userId,
        entries,
        new Set(newChanges.map((change) => Number(change.payload.anilistMediaId))),
      );

      await appendAnimeSyncChanges(
        owner.userId,
        id,
        [...newChanges, ...hints],
        run.cursor + chunk.length,
        run.lastAnimeId,
      );
      await finishAnimeSyncRun(owner.userId, id, 'ready');
    }

    return { cursor: run.cursor + chunk.length, total: run.total, done };
  } catch (error) {
    // A run must never be left stuck in `running` by an unexpected failure.
    const message = error instanceof Error ? error.message : 'Sync failed.';
    try {
      await finishAnimeSyncRun(owner.userId, runId, 'failed', message);
    } catch {
      // The run may not exist; the original failure is what matters.
    }
    return { error: message };
  }
}

/**
 * Imports the AniList activity feed into `anime_watch_log`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WRITES DIRECTLY. Nothing here is staged for approval, and that is the same
 * carve-out trophies get in `psn-actions.ts`: a dated fact about the past has
 * no owner-authored counterpart to overwrite, so a review step would be asking
 * the owner to ratify reality. Everything the sync PROPOSES still goes through
 * the review screen.
 *
 * RUN AFTER THE COMMIT, NOT BEFORE. A log row needs an `anime.id`, and the
 * shows a first sync creates do not exist until the owner applies the run — so
 * importing first would silently drop every activity for a new show. The button
 * calls this once the commit succeeds.
 *
 * An activity for a show that is STILL not in the library is skipped rather
 * than creating one. AniList's feed reaches back further than the list does
 * (a removed entry keeps its activity), and inventing a library row from a log
 * line would resurrect a show the owner deliberately deleted.
 *
 * NEVER FAILS THE SYNC. Like `advanceSyncEnrichmentAction` in the Games engine,
 * this is a best-effort extra: the library is already correct without it, and a
 * failed feed must not make a successful sync look broken.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export async function importAnimeActivityAction(): Promise<
  { readonly ok: true; readonly imported: number; readonly skipped: number } | { readonly ok: false; readonly error: string }
> {
  const owner = await requireOwner();

  if (!anilistConfigured()) {
    return { ok: false, error: 'AniList is not configured. Set ANILIST_USERNAME to your AniList username.' };
  }

  const activities = await fetchActivities();
  if (activities === null) {
    return { ok: false, error: 'Could not read your AniList activity feed. The library itself is up to date.' };
  }

  const byMediaId = await listAnilistIdMap(owner.userId);

  let skipped = 0;
  const rows = activities.flatMap((activity) => {
    const animeId = byMediaId.get(activity.mediaId);
    if (animeId === undefined) {
      skipped += 1;
      return [];
    }

    return [
      {
        animeId,
        anilistActivityId: activity.activityId,
        // AniList stamps activities in whole seconds since the epoch.
        watchedAt: new Date(activity.createdAt * 1000),
        episode: activity.progress,
        // `progress` when an episode number came through, `status` for a bare
        // "completed"/"dropped" entry. Stored as text, so an unknown future
        // kind degrades instead of failing the import.
        kind: activity.progress === null ? 'status' : 'progress',
      },
    ];
  });

  const imported = await insertWatchLogEntries(owner.userId, rows);

  revalidatePath('/anime', 'layout');
  return { ok: true, imported, skipped };
}

/**
 * Franchises AniList's relation graph says exist, staged for approval.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONLY PROPOSES WHAT WOULD ACTUALLY CHANGE SOMETHING.
 *
 * A sync that re-proposes the same franchises every single run trains the owner
 * to tick everything without reading, which is exactly the habit the review
 * screen exists to prevent. So a component is skipped when the owner has fewer
 * than two of its shows (one show is not a franchise), and skipped again when
 * every one of the shows they DO have is already filed in the same series.
 *
 * A partially-filed franchise is still proposed — that is the case where the
 * hint has real work to do — and `applySeriesHint` only ever fills a `NULL`
 * `series_id`, so approving it cannot move a show the owner placed by hand.
 *
 * Run at the END of the walk, alongside `new_anime`, because it needs the whole
 * snapshot rather than one chunk of it.
 * ─────────────────────────────────────────────────────────────────────────────
 */
async function planSeriesHints(
  ownerId: string,
  entries: readonly AniListEntry[],
  /**
   * Media ids this same run is proposing as `new_anime`.
   *
   * Counted as members, and that is what makes a FIRST import able to propose
   * franchises at all — the moment grouping is most useful is the one where
   * hundreds of shows arrive at once, and every one of them is new. Without
   * this a hint could only ever appear on the second sync.
   *
   * Safe because `COMMIT_ORDER` puts `series_hint` after `new_anime` and
   * `applySeriesHint` resolves media ids to rows at that point: approving the
   * grouping but not one of the shows simply files the members that exist.
   */
  proposedNew: ReadonlySet<number>,
): Promise<PlannedAnimeChange[]> {
  const components = groupRelatedMedia(
    entries.map((entry) => ({ mediaId: entry.mediaId, relatedIds: entry.relatedIds })),
  );
  if (components.length === 0) return [];

  const byMediaId = new Map(entries.map((entry) => [entry.mediaId, entry]));
  const membership = await listSeriesMembership(ownerId);

  const hints: PlannedAnimeChange[] = [];

  for (const mediaIds of components) {
    const owned = mediaIds.filter((mediaId) => membership.has(mediaId) || proposedNew.has(mediaId));
    if (owned.length < 2) continue;

    // Already grouped, all of it, in one place, with nothing new joining it.
    // Re-proposing that every run is how a review screen trains the owner to
    // tick without reading.
    const existing = owned.filter((mediaId) => membership.has(mediaId));
    const seriesIds = new Set(existing.map((mediaId) => membership.get(mediaId) ?? null));
    if (existing.length === owned.length && seriesIds.size === 1 && !seriesIds.has(null)) continue;

    const members = owned.flatMap((mediaId) => {
      const entry = byMediaId.get(mediaId);
      return entry === undefined
        ? []
        : [{ mediaId, titleRomaji: entry.titleRomaji, seasonYear: entry.seasonYear }];
    });

    const identity = seriesIdentityFor(owned);
    if (identity === null) continue;

    // The name comes from the EARLIEST member's title with its ordinal markers
    // stripped — a suggestion for a field the owner can rename, never an
    // identity. `anilistParentId` is the identity.
    const earliest = [...members].sort(
      (a, b) => (a.seasonYear ?? Number.POSITIVE_INFINITY) - (b.seasonYear ?? Number.POSITIVE_INFINITY),
    )[0];
    if (earliest === undefined) continue;

    const hint = planSeriesHint(members, suggestSeriesTitle(earliest.titleRomaji), identity);
    if (hint !== null) hints.push(hint);
  }

  return hints;
}

export async function setAnimeSyncChangeSelectedAction(
  changeId: string,
  selected: boolean,
): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    await setAnimeSyncChangeSelected(owner.userId, idSchema.parse(changeId), selected);
  } catch (error) {
    if (error instanceof z.ZodError) return fail('That change could not be updated.');
    throw error;
  }

  return ok();
}

/**
 * A union, not `extends ActionResult` — `ActionResult` is itself a union, and
 * extending it produces a type nothing satisfies. The counts ride on the
 * success arm only, because there are no counts to report on a failure.
 */
export type AnimeCommitOutcome =
  | { readonly ok: true; readonly applied: number; readonly created: number; readonly skipped: number }
  | { readonly ok: false; readonly error: string };

export async function commitAnimeSyncRunAction(runId: string): Promise<AnimeCommitOutcome> {
  const owner = await requireOwner();

  try {
    const result = await commitAnimeSyncRun(owner.userId, idSchema.parse(runId));
    revalidatePath('/anime', 'layout');
    return { ok: true, ...result };
  } catch (error) {
    if (
      error instanceof AnimeSyncRunNotFoundError ||
      error instanceof AnimeSyncRunAlreadyCommittedError ||
      error instanceof AnimeSyncRunNotReadyError
    ) {
      return { ok: false, error: error.message };
    }
    if (error instanceof z.ZodError) return { ok: false, error: 'That sync run could not be applied.' };
    throw error;
  }
}
