/**
 * The library's order, sorts and the two newer filters — pure rules.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * "MY ORDER" IS A HAND ORDER, SEEDED FROM THE SHEET.
 *
 * `games.sort_order` holds a position; `0` means "unplaced". `listGames`
 * orders by `sort_order` FIRST and only then by the sheet keys (shelf, wanted,
 * first-played year, title), so a library nobody has dragged reads exactly as
 * the sheet did, and the first drop pins every top-level row to an explicit
 * `1..n`. A new game is inserted at `min(sort_order) − 1` — the top, which is
 * where the owner asked for it. "Reset order" writes `0` everywhere and the
 * sheet keys take over again. No migration, nothing to seed.
 *
 * The other sorts here are READ-ONLY views of the same list. Choosing "Hours"
 * never rewrites anyone's position; it just shows the cards in that order,
 * with drag switched off (`LibraryView` enables it only in My order with no
 * filter active — a drop between two cards of a partial list has no clear
 * meaning for the games you cannot see).
 *
 * Pure TypeScript — same boundary as the rest of `src/server/games/`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  type CollectionGroup,
  type CollectionRow,
  type HourBearingRow,
  type TrophyBearingRow,
  rollUpHours,
  rollUpTrophies,
} from './collections';
import { type GameDlcRow, gameTotals } from './dlc';

export const LIBRARY_SORTS = ['my-order', 'year', 'hours', 'rating', 'title', 'trophies'] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];

export function isLibrarySort(value: string): value is LibrarySort {
  return (LIBRARY_SORTS as readonly string[]).includes(value);
}

export const LIBRARY_SORT_LABELS: Record<LibrarySort, string> = {
  'my-order': 'My order',
  year: 'Year',
  hours: 'Hours',
  rating: 'Rating',
  title: 'Title',
  trophies: 'Trophies',
};

/** What a sort needs to know about a row — satisfied by `Game`. */
export interface SortableGame extends CollectionRow, HourBearingRow, TrophyBearingRow {
  readonly title: string;
  readonly rating: number | null;
  readonly firstPlayedYear: number | null;
  readonly priceCents: number | null;
  readonly dlc: readonly GameDlcRow[];
}

/**
 * The figures a top-level row SHOWS: a collection's members rolled up when
 * they carry the figure (`rollUpHours`/`rollUpTrophies`), its own otherwise,
 * then base + DLC on top (`gameTotals`) — the same number the card, the
 * table and the panel print, so sorting by Hours agrees with what is on
 * screen.
 */
function shownFigures<T extends SortableGame>(
  group: CollectionGroup<T>,
): {
  readonly hoursTenths: number | null;
  readonly achievementsUnlocked: number | null;
} {
  const { game, members } = group;
  const base =
    members.length === 0
      ? game
      : (() => {
          const hoursSummary = rollUpHours(game, members);
          const trophies = rollUpTrophies(game, members);
          return {
            ...game,
            hoursTenths: hoursSummary.unsplit ? game.hoursTenths : hoursSummary.hoursTenths,
            achievementsUnlocked: trophies.unsplit ? game.achievementsUnlocked : trophies.unlocked,
          };
        })();
  const totals = gameTotals(base, game.dlc);
  return { hoursTenths: totals.hoursTenths, achievementsUnlocked: totals.achievementsUnlocked };
}

/** Descending on a nullable figure, nulls LAST, title as the tie-break — one comparator for every numeric sort. */
function byDescending<T extends SortableGame>(
  pick: (group: CollectionGroup<T>) => number | null,
): (a: CollectionGroup<T>, b: CollectionGroup<T>) => number {
  return (a, b) => {
    const av = pick(a);
    const bv = pick(b);
    if (av === null && bv === null) return a.game.title.localeCompare(b.game.title);
    if (av === null) return 1;
    if (bv === null) return -1;
    if (av !== bv) return bv - av;
    return a.game.title.localeCompare(b.game.title);
  };
}

/** The groups in the chosen sort. `my-order` returns the input untouched — that order IS the data. */
export function sortGroups<T extends SortableGame>(
  groups: readonly CollectionGroup<T>[],
  sort: LibrarySort,
): CollectionGroup<T>[] {
  switch (sort) {
    case 'my-order':
      return [...groups];
    case 'year':
      return [...groups].sort(byDescending((group) => group.game.firstPlayedYear));
    case 'hours':
      return [...groups].sort(byDescending((group) => shownFigures(group).hoursTenths));
    case 'rating':
      // A collection has no rating of its own, so it sorts last with the
      // unrated games — see `docs/GAMES.md`, "Where the figures live".
      return [...groups].sort(
        byDescending((group) => (group.members.length > 0 ? null : group.game.rating)),
      );
    case 'title':
      return [...groups].sort((a, b) => a.game.title.localeCompare(b.game.title));
    case 'trophies':
      return [...groups].sort(byDescending((group) => shownFigures(group).achievementsUnlocked));
  }
}

/**
 * The order after dropping `activeId` where `overId` sits — `arrayMove` on the
 * FULL top-level list, hidden rows included, so a wishlisted game the default
 * view does not show keeps its relative place. A no-op when either id is
 * missing or they are the same.
 */
export function moveTopLevel(
  ids: readonly string[],
  activeId: string,
  overId: string,
): readonly string[] {
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from === -1 || to === -1 || from === to) return ids;
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as string);
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filters
// ─────────────────────────────────────────────────────────────────────────────

export const RATING_FILTERS = ['all', '5', '4', '3', '2', '1', 'unrated'] as const;
export type RatingFilter = (typeof RATING_FILTERS)[number];

export const RATING_FILTER_LABELS: Record<RatingFilter, string> = {
  all: 'Any rating',
  '5': '5 stars',
  '4': '4+ stars',
  '3': '3+ stars',
  '2': '2+ stars',
  '1': '1+ stars',
  unrated: 'Unrated',
};

export function isRatingFilter(value: string): value is RatingFilter {
  return (RATING_FILTERS as readonly string[]).includes(value);
}

/** "4+ stars" is at least four; "Unrated" is exactly no rating. */
export function matchesRating(rating: number | null, filter: RatingFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'unrated') return rating === null;
  return rating !== null && rating >= Number(filter);
}

/** `'all'`, `'none'` (no first-played year), or a year as a string — the shape a select carries. */
export type YearFilter = 'all' | 'none' | `${number}`;

export function isYearFilter(value: string): value is YearFilter {
  return value === 'all' || value === 'none' || /^\d{4}$/.test(value);
}

export function matchesYear(year: number | null, filter: YearFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'none') return year === null;
  return year !== null && String(year) === filter;
}

/** The years a library has games in, newest first — the Year select's options. */
export function yearsIn(games: readonly { readonly firstPlayedYear: number | null }[]): number[] {
  const years = new Set<number>();
  for (const game of games) if (game.firstPlayedYear !== null) years.add(game.firstPlayedYear);
  return [...years].sort((a, b) => b - a);
}
