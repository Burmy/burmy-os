/**
 * AniList — GraphQL query text and response shaping. PURE: no fetch, no
 * database, no React. The one HTTP boundary is
 * `src/server/db/anime/anilist-client.ts`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SPLIT IS THE CODEBASE'S CONVENTION, NOT A PREFERENCE.
 *
 * `metadata.ts`/`igdb.ts`, `steam.ts`/`steam-client.ts` and `psn.ts`/
 * `psn-client.ts` are all the same shape: a pure module that knows the
 * provider's data, and a client module that knows how to reach it. Keeping
 * this half dependency-free is also what would let a `scripts/*.mjs` import it
 * under bare `node` later — a client module's `@/` alias imports cannot be
 * resolved that way.
 *
 * EVERY `toXxx` TAKES `unknown`. A third-party payload is an untrusted shape,
 * not a typed contract: a malformed entry is skipped rather than thrown on,
 * and a response with no list at all — the shape of an error response as much
 * as a genuinely empty library — collapses to `[]`. Same discipline as
 * `toPlayedTitles` in `psn.ts` and `toOwnedGames` in `steam.ts`.
 *
 * NOT VERIFIED AGAINST THE LIVE API. The sandbox this was written in blocks
 * `graphql.anilist.co`, so the field names below are from documentation rather
 * than from a response anyone has seen. The shaping functions are written to
 * survive being wrong — an unexpected shape yields `[]` or a skipped entry, not
 * a crash — but the QUERIES may need correcting on first contact.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  type AnimeFormat,
  type AnimeSeason,
  type AnimeSource,
  type AnimeStatus,
  formatFromAniList,
  seasonFromAniList,
  sourceFromAniList,
  statusFromAniList,
} from './taxonomy';

export const ANILIST_ENDPOINT = 'https://graphql.anilist.co';

/** One list entry, already folded into this app's vocabulary. */
export interface AniListEntry {
  readonly mediaId: number;
  readonly titleRomaji: string;
  readonly titleEnglish: string | null;
  readonly status: AnimeStatus;
  readonly progress: number;
  readonly repeatCount: number;
  readonly episodes: number | null;
  readonly durationMinutes: number | null;
  readonly format: AnimeFormat | null;
  readonly season: AnimeSeason | null;
  readonly seasonYear: number | null;
  readonly studio: string | null;
  /** Comma-joined, matching how `games.genre` is stored. */
  readonly genre: string | null;
  readonly source: AnimeSource | null;
  readonly synopsis: string | null;
  readonly coverUrl: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  /** Media ids AniList reports as prequels/sequels/parents — the raw material for series grouping. */
  readonly relatedIds: readonly number[];
}

/** One dated entry from the public activity feed. */
export interface AniListActivity {
  readonly activityId: number;
  readonly mediaId: number;
  readonly createdAt: number;
  /** The episode reached, when the activity says so. */
  readonly progress: number | null;
  readonly status: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The whole anime list in one request.
 *
 * `MediaListCollection` returns every entry grouped into lists, without
 * pagination — which is why the library sync needs no paging at all and only
 * the activity feed does. `relations` is requested here rather than per-show
 * later: one extra field on a query already being made beats N follow-up
 * requests against a 90-per-minute budget.
 */
export const LIST_QUERY = `
query ($userName: String) {
  MediaListCollection(userName: $userName, type: ANIME) {
    lists {
      entries {
        progress
        repeat
        status
        startedAt { year month day }
        completedAt { year month day }
        media {
          id
          title { romaji english }
          episodes
          duration
          format
          season
          seasonYear
          source
          genres
          description(asHtml: false)
          coverImage { large }
          studios(isMain: true) { nodes { name } }
          relations { edges { relationType node { id type } } }
        }
      }
    }
  }
}`.trim();

/**
 * One page of the public activity feed, newest first.
 *
 * Sorted `ID_DESC` rather than by date so paging is stable while new activity
 * arrives mid-walk — the same reason the Games syncs paginate on a keyset
 * rather than an offset.
 */
export const ACTIVITY_QUERY = `
query ($userName: String, $page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    activities(userName: $userName, type: ANIME_LIST, sort: ID_DESC) {
      ... on ListActivity {
        id
        createdAt
        progress
        status
        media { id }
      }
    }
  }
}`.trim();

// ─────────────────────────────────────────────────────────────────────────────
// Shaping
// ─────────────────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A non-negative integer, or `null`. AniList sends `null` for "unknown" and this must never become `0`. */
function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

/**
 * AniList's `FuzzyDate` (`{ year, month, day }`, any part nullable) as an ISO
 * date string.
 *
 * `null` unless all three parts are present. A year-only fuzzy date could be
 * rendered `2013-01-01`, and that is exactly the fabricated-precision trap
 * `games.release_precision` exists to avoid — except here there is no reason to
 * carry the partial value at all, because a start date nobody recorded properly
 * is not a fact worth half-storing.
 */
export function fuzzyDateToIso(value: unknown): string | null {
  const record = asRecord(value);
  if (record === null) return null;

  const year = asCount(record.year);
  const month = asCount(record.month);
  const day = asCount(record.day);
  if (year === null || month === null || day === null) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The main studio's name, or `null`. AniList returns a node list even when filtered to `isMain`. */
export function mainStudio(value: unknown): string | null {
  const nodes = asRecord(value)?.nodes;
  if (!Array.isArray(nodes)) return null;
  for (const node of nodes) {
    const name = asString(asRecord(node)?.name);
    if (name !== null) return name;
  }
  return null;
}

/** Genres comma-joined into the single column `games.genre` also uses, or `null` when there are none. */
export function joinGenres(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const names = value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
  return names.length === 0 ? null : names.join(', ');
}

/**
 * Media ids AniList links to this one, narrowed to the relations that actually
 * indicate a shared series.
 *
 * `PREQUEL`, `SEQUEL` and `PARENT` chain seasons of one show. `SIDE_STORY`,
 * `SPIN_OFF`, `ADAPTATION`, `CHARACTER` and the rest link things a person
 * would not file together, and including them would merge half of Gundam into
 * one row. Non-ANIME nodes are dropped: a manga relation is not a season.
 */
const SERIES_RELATIONS: ReadonlySet<string> = new Set(['PREQUEL', 'SEQUEL', 'PARENT']);

export function seriesRelatedIds(value: unknown): number[] {
  const edges = asRecord(value)?.edges;
  if (!Array.isArray(edges)) return [];

  return edges.flatMap((edge): number[] => {
    const record = asRecord(edge);
    if (record === null) return [];
    if (typeof record.relationType !== 'string' || !SERIES_RELATIONS.has(record.relationType)) return [];

    const node = asRecord(record.node);
    if (node === null || node.type !== 'ANIME') return [];

    const id = asCount(node.id);
    return id === null ? [] : [id];
  });
}

/**
 * A `MediaListCollection` response into entries.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEDUPED BY MEDIA ID, AND THAT IS NOT A TIDINESS MEASURE.
 *
 * AniList returns one `lists` array per list the owner has, and a CUSTOM list
 * does not move an entry — it copies it. A show in both "Completed" and a
 * custom "Favourites" list comes back twice, identical. Left undeduped, that
 * show is counted twice in every total, its episodes are added twice to the
 * headline time, and — worse — it is staged as two `new_anime` changes, the
 * second of which fails the unique index at commit.
 *
 * The same class of defect as the PSN sync's duplicate played titles, and the
 * reason that engine dedupes at its own boundary rather than downstream.
 *
 * The FIRST occurrence wins. Custom lists are appended after the standard ones
 * in AniList's response, so first-wins prefers the real status list; and since
 * the copies are identical it only matters that the choice is deterministic.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * An entry with no media id or no romaji title is skipped — both are required
 * columns, and a row that cannot be identified cannot be matched on a later
 * sync either.
 */
export function toListEntries(payload: unknown): AniListEntry[] {
  const lists = asRecord(asRecord(asRecord(payload)?.data)?.MediaListCollection)?.lists;
  if (!Array.isArray(lists)) return [];

  const seen = new Set<number>();

  const all = lists.flatMap((list): AniListEntry[] => {
    const entries = asRecord(list)?.entries;
    if (!Array.isArray(entries)) return [];

    return entries.flatMap((entry): AniListEntry[] => {
      const record = asRecord(entry);
      if (record === null) return [];

      const media = asRecord(record.media);
      if (media === null) return [];

      const mediaId = asCount(media.id);
      const titleRomaji = asString(asRecord(media.title)?.romaji);
      if (mediaId === null || titleRomaji === null) return [];

      return [
        {
          mediaId,
          titleRomaji,
          titleEnglish: asString(asRecord(media.title)?.english),
          status: statusFromAniList(record.status),
          progress: asCount(record.progress) ?? 0,
          repeatCount: asCount(record.repeat) ?? 0,
          episodes: asCount(media.episodes),
          durationMinutes: asCount(media.duration),
          format: formatFromAniList(media.format),
          season: seasonFromAniList(media.season),
          seasonYear: asCount(media.seasonYear),
          studio: mainStudio(media.studios),
          genre: joinGenres(media.genres),
          source: sourceFromAniList(media.source),
          synopsis: asString(media.description),
          coverUrl: asString(asRecord(media.coverImage)?.large),
          startedAt: fuzzyDateToIso(record.startedAt),
          completedAt: fuzzyDateToIso(record.completedAt),
          relatedIds: seriesRelatedIds(media.relations),
        },
      ];
    });
  });

  return all.filter((entry) => {
    if (seen.has(entry.mediaId)) return false;
    seen.add(entry.mediaId);
    return true;
  });
}

/** Whether the activity feed has another page. `false` on any unexpected shape — stopping early beats looping forever. */
export function hasNextActivityPage(payload: unknown): boolean {
  const page = asRecord(asRecord(asRecord(payload)?.data)?.Page);
  return asRecord(page?.pageInfo)?.hasNextPage === true;
}

/**
 * One page of activities.
 *
 * The `activities` array is heterogeneous — AniList returns text and message
 * activities alongside list ones, and the inline fragment leaves those as bare
 * objects with none of the fields below. They are skipped by the same id/media
 * check that skips a malformed entry, with no separate type test needed.
 */
export function toActivities(payload: unknown): AniListActivity[] {
  const activities = asRecord(asRecord(asRecord(payload)?.data)?.Page)?.activities;
  if (!Array.isArray(activities)) return [];

  return activities.flatMap((entry): AniListActivity[] => {
    const record = asRecord(entry);
    if (record === null) return [];

    const activityId = asCount(record.id);
    const mediaId = asCount(asRecord(record.media)?.id);
    const createdAt = asCount(record.createdAt);
    if (activityId === null || mediaId === null || createdAt === null) return [];

    return [
      {
        activityId,
        mediaId,
        createdAt,
        progress: parseActivityProgress(record.progress),
        status: asString(record.status),
      },
    ];
  });
}

/**
 * AniList's activity `progress` is a STRING, and not always a single number:
 * catching up several episodes at once reads `"5 - 8"`.
 *
 * The episode REACHED is what the log records, so a range yields its upper
 * bound. Anything unparseable yields `null` rather than `0` — "AniList did not
 * say" and "episode zero" are different, and only one of them is a real thing.
 */
export function parseActivityProgress(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== 'string') return null;

  const numbers = value.match(/\d+/g);
  if (numbers === null || numbers.length === 0) return null;

  const last = numbers[numbers.length - 1];
  const parsed = Number.parseInt(last ?? '', 10);
  return Number.isFinite(parsed) ? parsed : null;
}
