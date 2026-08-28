/**
 * Collections — a bundle row that wraps several titles the owner counts
 * separately.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE COLLECTION COUNTING RULE, IN ONE SENTENCE
 *
 *   Anything that counts GAMES excludes collection rows.
 *   Anything that sums HOURS, MONEY or TROPHIES includes everything.
 *
 * A collection ("Uncharted: The Nathan Drake Collection") is one purchase
 * with one price, one play time and one trophy list, wrapping several
 * distinct games the owner counts separately — exactly how the source
 * spreadsheet modelled it. So the collection row is a WRAPPER, not a game
 * that was played: counting it alongside its own three titles would report
 * four games where there are three, and double its platform in every
 * distribution.
 *
 * The sums need no rule at all, and that is the point: a title inside a
 * collection carries NULL hours, NULL price and `platinum = false`, so every
 * existing `SUM` and `reduce` in `stats.ts` already excludes it for free.
 * Only the COUNTS need this filter, which is why it is a helper applied at a
 * few named call sites rather than a filter at the read boundary the way
 * `wanted` is (`listGameStatRows`) — filtering collections out there would
 * take their hours and money with them.
 *
 * Derived from the rows themselves rather than a stored flag: a row is a
 * collection exactly when some other row names it. One pass, no extra query,
 * and it keeps this module free of the database per `src/server/games/`'s
 * framework-free charter.
 *
 * Edge case, stated rather than engineered around: `listGameStatRows`
 * excludes `wanted` rows, so a WISHLISTED collection whose titles are not
 * wishlisted would not be recognised as a collection there. That state has no
 * meaning (a collection you do not own has nothing inside it to have played)
 * and no way to reach it in the UI.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Pure TypeScript. No React, no Next, no database — same boundary rule as
 * `src/server/finance/`.
 */

/** The projection both helpers here need. Satisfied by `Game` and by `GameStatRow` alike. */
export interface CollectionRow {
  readonly id: string;
  /** The collection this title belongs to — `null` for a standalone game AND for a collection row itself. */
  readonly collectionId: string | null;
}

/** The ids of every row that some OTHER row names as its collection. */
export function collectionIdsIn<T extends CollectionRow>(rows: readonly T[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    // A self-reference is not a collection — see `groupByCollection`.
    if (row.collectionId !== null && row.collectionId !== row.id) ids.add(row.collectionId);
  }
  return ids;
}

/** The rows that count as a GAME: the titles inside collections, plus every standalone game. Excludes collection wrappers. */
export function countableGames<T extends CollectionRow>(rows: readonly T[]): T[] {
  const collections = collectionIdsIn(rows);
  return rows.filter((row) => !collections.has(row.id));
}

/** One top-level row plus the titles filed under it. `members` is empty for a standalone game. */
export interface CollectionGroup<T extends CollectionRow> {
  readonly game: T;
  readonly members: readonly T[];
}

/**
 * The library's two-level shape: top-level rows in input order, each carrying
 * its own titles in input order.
 *
 * Input order is preserved rather than re-sorted, because the caller has
 * already sorted — and a collection's members are all but guaranteed NOT to
 * sort adjacent to it. `listGames` orders by recency, and a title inside a
 * collection carries no hours and usually no year, so it lands at the far end
 * of the library from the collection that holds its play data. A single
 * ordered pass would routinely reach a member before its parent, so this
 * takes two passes over the same array.
 *
 * THREE THINGS THAT MUST NEVER MAKE A ROW DISAPPEAR, since this function
 * decides what the library renders:
 *
 *   - A member whose collection is absent from `rows` (filtered out, or on
 *     the wishlist and hidden) becomes a top-level row of its own.
 *   - A row naming ITSELF as its collection is treated as standalone. The
 *     write path rejects this (`assertCollectionTargetValid`) and the FK
 *     cannot express the one-level rule on its own, so this is the cheap
 *     guard against a row that would otherwise be its own parent and its own
 *     child at once.
 *   - A row inside a collection that is ITSELF inside a collection is
 *     promoted to top level. Also rejected by the write path; the fallback
 *     exists so a two-level chain reached some other way (a hand-run SQL
 *     fix) shows up looking wrong rather than not showing up at all.
 */
export function groupByCollection<T extends CollectionRow>(
  rows: readonly T[],
): CollectionGroup<T>[] {
  const present = new Set(rows.map((row) => row.id));

  function parentOf(row: T): string | null {
    if (row.collectionId === null || row.collectionId === row.id) return null;
    return present.has(row.collectionId) ? row.collectionId : null;
  }

  const groups = new Map<string, { game: T; members: T[] }>();
  const ordered: { game: T; members: T[] }[] = [];

  function open(row: T): { game: T; members: T[] } {
    const group = { game: row, members: [] as T[] };
    groups.set(row.id, group);
    ordered.push(group);
    return group;
  }

  for (const row of rows) {
    if (parentOf(row) === null) open(row);
  }

  for (const row of rows) {
    const parent = parentOf(row);
    if (parent === null) continue;
    const group = groups.get(parent);
    if (group === undefined) open(row);
    else group.members.push(row);
  }

  return ordered;
}
