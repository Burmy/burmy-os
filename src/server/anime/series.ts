/**
 * Series — a franchise several `anime` rows belong to.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SERIES RULE, IN ONE SENTENCE
 *
 *   Anything that counts SHOWS counts `anime` rows and never `anime_series`
 *   rows. Anything that sums episodes, time, studios or genres reads `anime`
 *   rows only.
 *
 * That is the whole rule, and it is deliberately far simpler than Games'
 * equivalent (`src/server/games/collections.ts`), which needs a helper at
 * every counting call site. The difference is structural, not stylistic: a
 * Games collection is a row in `games`, so it can be miscounted as a game, and
 * `countableGames` exists to stop that. A series is a row in a DIFFERENT
 * TABLE. Nothing that reads `anime` can accidentally return one, so there is
 * no counting filter to apply and none to forget.
 *
 * Choosing the separate table is what bought that, and the product reason came
 * first: a franchise is not something you watched. It has no episode count, no
 * progress, no status, no start or finish date — nothing to record. Games'
 * self-FK works because a boxed set IS a thing you bought, with one price and
 * one play time.
 *
 * A series therefore stores almost nothing. Everything it displays — episode
 * totals, time watched, the airing span, the cover — is derived from its
 * members at read time, which is the same invariant Finance states as "never
 * store a total".
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Pure TypeScript. No React, no Next, no database — the same boundary rule
 * `src/server/finance/` and `src/server/games/` hold.
 */

import { type Minutes, episodesWatched, minutesWatched, sumMinutes } from './runtime';
import { type AnimeSeason, ANIME_SEASONS } from './taxonomy';

/** The projection every helper here needs. `Anime` satisfies it; so does any narrower stat row. */
export interface SeriesMemberRow {
  readonly id: string;
  readonly seriesId: string | null;
  readonly titleRomaji: string;
  readonly episodes: number | null;
  readonly progress: number;
  readonly repeatCount: number;
  readonly durationMinutes: number | null;
  readonly season: AnimeSeason | null;
  readonly seasonYear: number | null;
  readonly coverUrl: string | null;
}

/** Members of one series, in the order they aired — which is the order a person watches them. */
export function membersOf<T extends SeriesMemberRow>(rows: readonly T[], seriesId: string): T[] {
  return rows.filter((row) => row.seriesId === seriesId).sort(compareByAiring);
}

/**
 * Airing order: by year, then by season within the year, then by title.
 *
 * A season with no airing date sorts LAST rather than first. An unknown date
 * is usually a specials/OVA entry the owner added by hand, and putting it
 * ahead of a dated first season would claim an order the data does not
 * support — where trailing it only says "we do not know where this goes".
 */
export function compareByAiring(a: SeriesMemberRow, b: SeriesMemberRow): number {
  const yearA = a.seasonYear ?? Number.POSITIVE_INFINITY;
  const yearB = b.seasonYear ?? Number.POSITIVE_INFINITY;
  if (yearA !== yearB) return yearA - yearB;

  const seasonA = a.season === null ? ANIME_SEASONS.length : ANIME_SEASONS.indexOf(a.season);
  const seasonB = b.season === null ? ANIME_SEASONS.length : ANIME_SEASONS.indexOf(b.season);
  if (seasonA !== seasonB) return seasonA - seasonB;

  return a.titleRomaji.localeCompare(b.titleRomaji);
}

/** Everything a series page shows about itself, all of it derived from its members. */
export interface SeriesTotals {
  /** How many `anime` rows are in it. A series is never counted as a show itself. */
  readonly showCount: number;
  /** Episodes actually watched across every member, rewatches included. */
  readonly episodesWatched: number;
  /** `null` when NO member has a known episode duration — never a fabricated zero. */
  readonly minutesWatched: Minutes | null;
  /** The earliest and latest airing years present, or `null` when no member is dated. */
  readonly firstYear: number | null;
  readonly lastYear: number | null;
}

export function seriesTotals(members: readonly SeriesMemberRow[]): SeriesTotals {
  const years = members
    .map((row) => row.seasonYear)
    .filter((year): year is number => typeof year === 'number');

  return {
    showCount: members.length,
    episodesWatched: members.reduce(
      (total, row) => total + episodesWatched(row.progress, row.repeatCount, row.episodes),
      0,
    ),
    minutesWatched: sumMinutes(
      members.map((row) => minutesWatched(row.progress, row.repeatCount, row.episodes, row.durationMinutes)),
    ),
    firstYear: years.length === 0 ? null : Math.min(...years),
    lastYear: years.length === 0 ? null : Math.max(...years),
  };
}

/**
 * The cover a series shows when it has none of its own.
 *
 * DERIVED rather than copied onto `anime_series.cover_url` at import: a stored
 * copy and the member it came from can drift, and there is no reconciliation
 * step that would ever notice. The earliest dated member with art wins, which
 * is the season a person pictures when they name the franchise.
 */
export function seriesCover(
  own: string | null,
  members: readonly SeriesMemberRow[],
): string | null {
  if (own !== null) return own;
  return [...members].sort(compareByAiring).find((row) => row.coverUrl !== null)?.coverUrl ?? null;
}

/**
 * A franchise name from one season's title — "Attack on Titan Season 3 Part 2"
 * becomes "Attack on Titan".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UNDER-STRIPS ON PURPOSE, exactly like `merchantKey` in Finance.
 *
 * Stripping too little leaves two series where there should be one, which the
 * owner fixes with one click in the "Part of" picker. Stripping too much MERGES
 * TWO DIFFERENT SHOWS, and the only signal is that a franchise page quietly
 * contains something that does not belong to it. So this only removes suffixes
 * that are unambiguously ordinal markers, never a trailing word that could be
 * part of a real title: "Bleach: Thousand-Year Blood War" keeps its subtitle.
 *
 * This is a SUGGESTION for a name field the owner can edit, never an identity
 * key. `anime_series.anilist_parent_id` is what makes a re-sync resolve the
 * same series; deriving identity from a heuristic title is the mistake
 * `dedupe_key`/`merchant_key` exists to document.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function suggestSeriesTitle(title: string): string {
  let result = title.trim();

  for (;;) {
    const next = result
      // "2nd Season" FIRST — the general rule below would otherwise strip
      // "Season" on its own and leave a stranded "- 2nd" that nothing matches.
      .replace(/[\s:\-–—]+\d+(st|nd|rd|th)\s+season$/i, '')
      // "Season 3", "Part 2", "Cour 2", "Final Season"
      .replace(/[\s:\-–—]+(the\s+)?(final\s+)?(season|part|cour)\s*\d*$/i, '')
      // A bare trailing Roman numeral or digit — "Overlord III", "Mushoku Tensei 2"
      .replace(/\s+(?:[IVX]{1,4}|\d{1,2})$/, '')
      .trim()
      // A separator left dangling by one of the above.
      .replace(/[\s:\-–—]+$/, '')
      .trim();

    if (next === result || next === '') return result;
    result = next;
  }
}
