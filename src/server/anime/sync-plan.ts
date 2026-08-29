/**
 * What an AniList sync PROPOSES. Pure — no database, no fetch — so every rule
 * below is testable without mocking anything, the same split
 * `src/server/games/sync-plan.ts` holds.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOTHING HERE WRITES. These functions return staged changes the owner
 * approves; the only code allowed to touch `anime` is the commit.
 *
 * THE GOVERNING RULE: `null` from AniList means "AniList did not say", never
 * "the value is zero". An airing show with no final episode count, a title with
 * no duration recorded — writing either as 0 would erase a real number and
 * silently shrink every total derived from it. Every proposal below is gated on
 * a non-null AniList value.
 *
 * ONE MORE, SPECIFIC TO THIS MODULE: progress only ever moves FORWARD from a
 * sync. AniList is where watching is logged, so its progress is normally
 * ahead — but a re-add or a list edit can send a lower number, and quietly
 * rewinding episode 24 to episode 3 would look like data loss with no way to
 * tell it from a real correction. A decrease is staged as an ordinary
 * field_update the owner can see and approve, never applied silently, and is
 * marked so the review screen can say what it is.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { AniListEntry } from './anilist';
import type { AnimeStatus } from './taxonomy';

export type AnimeSyncChangeKind = 'link' | 'field_update' | 'new_anime' | 'series_hint';

export interface PlannedAnimeChange {
  readonly kind: AnimeSyncChangeKind;
  /** Null only for `new_anime`, which by definition has no library row yet. */
  readonly animeId: string | null;
  readonly title: string;
  readonly payload: Record<string, unknown>;
}

/** The stored row as the planner sees it — a narrow projection, not the whole record. */
export interface StoredAnimeForSync {
  readonly id: string;
  readonly title: string;
  readonly anilistMediaId: number | null;
  readonly status: AnimeStatus;
  readonly progress: number;
  readonly repeatCount: number;
  readonly episodes: number | null;
  readonly durationMinutes: number | null;
  readonly studio: string | null;
  readonly genre: string | null;
  readonly coverUrl: string | null;
}

/**
 * Fields a sync may propose changing, and the ONLY ones.
 *
 * Deliberately excludes `notes` and `series_id`: both are the owner's own, and
 * AniList has no opinion about either. `title_romaji` is excluded too — a
 * retitle would collide with the unique title index and is not worth the
 * machinery for a change AniList almost never makes.
 */
export const SYNCABLE_ANIME_FIELDS = [
  'status',
  'progress',
  'repeatCount',
  'episodes',
  'durationMinutes',
  'studio',
  'genre',
  'coverUrl',
] as const;

export type SyncableAnimeField = (typeof SYNCABLE_ANIME_FIELDS)[number];

function fieldChange(
  stored: StoredAnimeForSync,
  field: SyncableAnimeField,
  from: unknown,
  to: unknown,
  extra: Record<string, unknown> = {},
): PlannedAnimeChange {
  return {
    kind: 'field_update',
    animeId: stored.id,
    title: stored.title,
    payload: { field, from, to, ...extra },
  };
}

/**
 * Everything a sync proposes for a row it has matched to an AniList entry.
 *
 * Each field is compared and staged only when it actually differs — a sync
 * that proposes a no-op every run trains the owner to approve without reading.
 */
export function planLinkedAnimeChanges(
  stored: StoredAnimeForSync,
  entry: AniListEntry,
): PlannedAnimeChange[] {
  const changes: PlannedAnimeChange[] = [];

  if (stored.anilistMediaId === null) {
    changes.push({
      kind: 'link',
      animeId: stored.id,
      title: stored.title,
      // `matchedTitle` is display-only and the review screen needs it: a link
      // reading "matched to #16498" is unverifiable, and the owner is being
      // asked to approve it precisely because a title match can be wrong.
      payload: { anilistMediaId: entry.mediaId, matchedTitle: entry.titleRomaji },
    });
  }

  if (entry.status !== stored.status) {
    changes.push(fieldChange(stored, 'status', stored.status, entry.status));
  }

  if (entry.progress !== stored.progress) {
    // Flagged, not blocked — see the module header. The review screen shows a
    // decrease differently so it cannot be approved by reflex.
    const decrease = entry.progress < stored.progress;
    changes.push(fieldChange(stored, 'progress', stored.progress, entry.progress, decrease ? { decrease: true } : {}));
  }

  if (entry.repeatCount !== stored.repeatCount) {
    changes.push(fieldChange(stored, 'repeatCount', stored.repeatCount, entry.repeatCount));
  }

  // Everything below is show METADATA rather than the owner's progress, and is
  // proposed only when AniList actually has a value. `null` never overwrites.
  if (entry.episodes !== null && entry.episodes !== stored.episodes) {
    changes.push(fieldChange(stored, 'episodes', stored.episodes, entry.episodes));
  }
  if (entry.durationMinutes !== null && entry.durationMinutes !== stored.durationMinutes) {
    changes.push(fieldChange(stored, 'durationMinutes', stored.durationMinutes, entry.durationMinutes));
  }
  if (entry.studio !== null && entry.studio !== stored.studio) {
    changes.push(fieldChange(stored, 'studio', stored.studio, entry.studio));
  }
  if (entry.genre !== null && entry.genre !== stored.genre) {
    changes.push(fieldChange(stored, 'genre', stored.genre, entry.genre));
  }
  // Cover art is filled only when MISSING, never replaced: the owner may have
  // set one deliberately, and a churning AniList image would propose the same
  // swap forever.
  if (entry.coverUrl !== null && stored.coverUrl === null) {
    changes.push(fieldChange(stored, 'coverUrl', null, entry.coverUrl));
  }

  return changes;
}

/**
 * A show on AniList that has no library row at all.
 *
 * Staged, never inserted directly — the owner approves the set. The payload
 * carries everything needed to create the row, because at commit time the
 * AniList snapshot is no longer in hand.
 */
export function planNewAnimeChange(entry: AniListEntry): PlannedAnimeChange {
  return {
    kind: 'new_anime',
    animeId: null,
    title: entry.titleRomaji,
    payload: {
      anilistMediaId: entry.mediaId,
      titleRomaji: entry.titleRomaji,
      titleEnglish: entry.titleEnglish,
      status: entry.status,
      progress: entry.progress,
      repeatCount: entry.repeatCount,
      episodes: entry.episodes,
      durationMinutes: entry.durationMinutes,
      format: entry.format,
      season: entry.season,
      seasonYear: entry.seasonYear,
      studio: entry.studio,
      genre: entry.genre,
      source: entry.source,
      synopsis: entry.synopsis,
      coverUrl: entry.coverUrl,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
    },
  };
}

/**
 * A franchise AniList's relation graph says exists, staged for approval.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * APPROVING ONE ACTUALLY GROUPS THE SHOWS. It did not always.
 *
 * The first version of this staged an advisory note that applied nothing, which
 * meant a checkbox the owner could tick, that counted toward "Apply N selected
 * changes", and that then did nothing at all. A control which reports success
 * and changes nothing is worse than no control. So the payload carries
 * everything the commit needs to do the work: a stable identity, a suggested
 * name, and the media ids to file in.
 *
 * MEDIA IDS, NOT ROW IDS. Half of a franchise can be `new_anime` in the very
 * same run and have no row yet at staging time. The commit resolves media ids
 * to rows AFTER the inserts (`COMMIT_ORDER` puts `series_hint` last), which is
 * also what makes a hint survive being approved in a later run than the one
 * that created the shows.
 *
 * STILL STAGED UNSELECTED. A relation graph chains sequels cleanly and is much
 * less sure about recaps, compilation films and side stories, and series
 * membership decides how the library COUNTS and GROUPS. Unselected means the
 * owner has to look at the list of titles and agree, which is exactly the
 * amount of ceremony an unreliable signal deserves.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function planSeriesHint(
  members: readonly { readonly mediaId: number; readonly titleRomaji: string; readonly seasonYear: number | null }[],
  suggestedTitle: string,
  anilistParentId: number,
): PlannedAnimeChange | null {
  // One show is not a franchise. Callers filter for this too; enforced here so
  // the rule holds wherever the planner is used.
  if (members.length < 2) return null;

  // Earliest first, so the title list on the review screen reads in the order
  // the owner watched them.
  const ordered = [...members].sort(
    (a, b) => (a.seasonYear ?? Number.POSITIVE_INFINITY) - (b.seasonYear ?? Number.POSITIVE_INFINITY),
  );

  return {
    kind: 'series_hint',
    // No single row owns a franchise proposal — it is about a SET.
    animeId: null,
    title: suggestedTitle,
    payload: {
      anilistParentId,
      seriesTitle: suggestedTitle,
      mediaIds: ordered.map((member) => member.mediaId),
      titles: ordered.map((member) => member.titleRomaji),
    },
  };
}

/** `series_hint` is advisory and must never be pre-selected — the review screen requires it be a deliberate click. */
export function defaultSelected(kind: AnimeSyncChangeKind): boolean {
  return kind !== 'series_hint';
}
