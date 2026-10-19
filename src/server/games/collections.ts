/**
 * Collections — a bundle row that wraps several titles the owner counts
 * separately.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE COLLECTION COUNTING RULE, IN ONE SENTENCE
 *
 *   Anything that counts GAMES excludes collection rows.
 *   Anything that sums MONEY includes everything.
 *   Anything that sums HOURS or TROPHIES goes through `collectionAdjustedRows` first.
 *
 * A collection ("Uncharted: The Nathan Drake Collection") is one purchase
 * with one price and one play time, wrapping several distinct games the owner
 * counts separately — exactly how the source spreadsheet modelled it. So the
 * collection row is a WRAPPER, not a game that was played: counting it
 * alongside its own three titles would report four games where there are
 * three, and double its platform in every distribution.
 *
 * Money needs no rule at all, and that is the point: a title inside a
 * collection carries NULL price (one boxed set was one purchase), so every
 * existing `SUM` and `reduce` in `stats.ts` already excludes it for free.
 * Only the COUNTS need this filter, which is why it is a helper applied at a
 * few named call sites rather than a filter at the read boundary the way
 * `wanted` is (`listGameStatRows`) — filtering collections out there would
 * take their money with them.
 *
 * HOURS AND TROPHIES ROLL UP FROM THE MEMBERS. A title inside a set carries
 * its own trophies (PSN's model from the start) and, since 2026-10-19 at the
 * owner's request ("hours should be individual"), its own hours too. The
 * collection reports the SUM of what its members carry, and falls back to its
 * own stored figure only while no member carries any — see `rollUpTrophies`
 * and `rollUpHours` at the bottom of this file. A flat sum over every row
 * would then count a figure twice, which is what `collectionAdjustedRows` is
 * for. Price stays one figure on the collection.
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
 * already sorted — and a collection's members are not guaranteed to sort
 * adjacent to it. `listGames` orders by shelf, then first-played year, then
 * title, and a title inside a collection sorts on ITS OWN year and title, so
 * it can land well away from the collection that wraps it. A single ordered
 * pass would routinely reach a member before its parent, so this takes two
 * passes over the same array.
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

// ─────────────────────────────────────────────────────────────────────────────
// Trophies — which row owns them, and how a collection reports a total
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TROPHIES BELONG TO THE INDIVIDUAL TITLE, NOT TO THE SET. PSN SAYS SO.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The header of this file used to say a collection carries "one trophy list"
 * alongside its one price and one play time. That is true of price, was
 * false of trophies from the start, and stopped being true of hours on
 * 2026-10-19 (`rollUpHours`, below, at the owner's request). PSN's own data
 * model is the evidence for trophies:
 *
 *   getUserPlayedGames  -> one entry per PRODUCT, keyed by `titleId`
 *                          (CUSA…/PPSA…), carrying ONE cumulative
 *                          `playDuration`. The Nathan Drake Collection is a
 *                          single entry here.
 *   getUserTitles       -> one entry per TROPHY LIST, keyed by
 *                          `npCommunicationId` (NPWR…), each with its own
 *                          defined/earned counts and its own platinum. The
 *                          Nathan Drake Collection is THREE entries here, one
 *                          per remastered game.
 *
 * So hours genuinely cannot be split per title and trophies genuinely can —
 * and treating them the same way is what put 154 achievements on a row that
 * stood for a whole boxed set, with no way to say which of the three games
 * earned any of them.
 *
 * THE PRECEDENCE RULE, AND WHY IT IS NOT A STORED FLAG:
 *
 *   If any member carries trophy data, the collection's figure is the SUM of
 *   its members. Otherwise the collection's own stored figure is used, and
 *   reported as UNSPLIT.
 *
 * The fallback is what keeps a real number on screen for a set imported from
 * the spreadsheet as one lump, before any sync has linked its titles to their
 * separate PSN trophy lists. It is deliberately a derivation from the data
 * rather than a `legacy_rollup` column: a column would be a second stored
 * fact about the same thing, and the moment members gained trophies the two
 * would disagree with nothing to arbitrate them. Precedence cannot disagree
 * with itself. Same instinct as CLAUDE.md's "never store a total".
 * ─────────────────────────────────────────────────────────────────────────────
 */
export interface TrophyBearingRow {
  readonly achievementsUnlocked: number | null;
  readonly achievementsTotal: number | null;
  readonly platinum: boolean;
}

export interface CollectionTrophySummary {
  readonly unlocked: number | null;
  readonly total: number | null;
  /** True when EVERY member has its own platinum — a set is only fully platinumed when all of its games are. */
  readonly platinum: boolean;
  /**
   * The figure is the collection's own unsplit lump rather than a sum of its
   * members. The UI says so rather than presenting it as a per-title
   * breakdown it is not.
   */
  readonly unsplit: boolean;
}

/** Any of the three trophy fields carrying a value — the test for "this row has trophy data of its own". */
export function hasOwnTrophyData(row: TrophyBearingRow): boolean {
  return row.achievementsUnlocked !== null || row.achievementsTotal !== null || row.platinum;
}

/**
 * What a collection reports for trophies — see the precedence rule above.
 *
 * A `null` unlocked/total means "not tracked", which is different from zero
 * and has to stay different: a game with 0 of 42 earned is a fact, and a game
 * nobody has linked to a trophy list is not. So a sum over members that all
 * carry `null` stays `null` rather than collapsing to 0.
 */
export function rollUpTrophies(
  collection: TrophyBearingRow,
  members: readonly TrophyBearingRow[],
): CollectionTrophySummary {
  const contributing = members.filter(hasOwnTrophyData);

  if (contributing.length === 0) {
    return {
      unlocked: collection.achievementsUnlocked,
      total: collection.achievementsTotal,
      platinum: collection.platinum,
      unsplit: hasOwnTrophyData(collection),
    };
  }

  const sum = (pick: (row: TrophyBearingRow) => number | null): number | null => {
    const values = contributing.map(pick).filter((value): value is number => value !== null);
    return values.length === 0 ? null : values.reduce((total, value) => total + value, 0);
  };

  return {
    unlocked: sum((row) => row.achievementsUnlocked),
    total: sum((row) => row.achievementsTotal),
    // EVERY member, not `some` — a set with one platinum out of three has not
    // been platinumed, and reporting it as such would overstate the shelf.
    platinum: members.length > 0 && members.every((row) => row.platinum),
    unsplit: false,
  };
}

/**
 * Trophy figures for a whole library, with each collection replaced by its
 * rolled-up total and its members zeroed out.
 *
 * THE DOUBLE-COUNT THIS EXISTS TO PREVENT. `stats.ts` sums
 * `achievementsUnlocked` across every row, which was safe only because a
 * member always carried `null`. Once members carry their own trophies AND a
 * collection can still carry an unsplit lump, a flat sum counts the same
 * achievements twice — the identical shape to Finance's double-counted
 * card-payment pair. Every trophy aggregate reads through here instead.
 */
export function trophyAdjustedRows<T extends CollectionRow & TrophyBearingRow>(
  rows: readonly T[],
): (Omit<T, 'achievementsUnlocked' | 'achievementsTotal' | 'platinum'> & TrophyBearingRow)[] {
  const collections = collectionIdsIn(rows);
  if (collections.size === 0) return [...rows];

  const membersByCollection = new Map<string, T[]>();
  for (const row of rows) {
    if (row.collectionId === null || row.collectionId === row.id) continue;
    const existing = membersByCollection.get(row.collectionId);
    if (existing) existing.push(row);
    else membersByCollection.set(row.collectionId, [row]);
  }

  return rows.map((row) => {
    if (!collections.has(row.id)) return row;

    const summary = rollUpTrophies(row, membersByCollection.get(row.id) ?? []);
    // A collection whose members carry the trophies contributes NOTHING of its
    // own — the members are still in this array and already carry them.
    if (!summary.unsplit) {
      return { ...row, achievementsUnlocked: null, achievementsTotal: null, platinum: false };
    }
    return row;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Hours — the same precedence rule, asked for by the owner on 2026-10-19
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HOURS BELONG TO THE INDIVIDUAL TITLE TOO. "I feel like hours should be
 * individual" — the owner, 2026-10-19, and the rule is deliberately the one
 * trophies already follow rather than a third variant:
 *
 *   If any member carries hours, the collection's figure is the SUM of its
 *   members. Otherwise the collection's own stored figure is used, and
 *   reported as UNSPLIT.
 *
 * The fallback keeps the two Uncharted sets honest: they were imported as one
 * lump each (42.9h, 44.2h) with no per-game figure anywhere, and they keep
 * showing that lump until the owner types hours on a member — at which point
 * the lump stops counting and the members do. Derived, not stored, for the
 * reason `rollUpTrophies` gives: precedence cannot disagree with itself.
 *
 * A member's hours are its own in every sense: it can split them across
 * years (`game_play_years`) and carry DLC, exactly like a standalone game.
 * Price is NOT rolled up — a boxed set was bought once.
 */
export interface HourBearingRow {
  readonly hoursTenths: number | null;
}

export interface CollectionHoursSummary {
  readonly hoursTenths: number | null;
  /** The figure is the collection's own unsplit lump rather than a sum of its members. */
  readonly unsplit: boolean;
}

export function rollUpHours(
  collection: HourBearingRow,
  members: readonly HourBearingRow[],
): CollectionHoursSummary {
  const contributing = members.filter((row) => row.hoursTenths !== null);

  if (contributing.length === 0) {
    return { hoursTenths: collection.hoursTenths, unsplit: collection.hoursTenths !== null };
  }

  return {
    hoursTenths: contributing.reduce((total, row) => total + (row.hoursTenths ?? 0), 0),
    unsplit: false,
  };
}

/**
 * Hours for a whole library, with each collection whose members carry hours
 * contributing none of its own — the members are still in the array and
 * already carry them. Same shape and same reason as `trophyAdjustedRows`.
 */
export function hoursAdjustedRows<T extends CollectionRow & HourBearingRow>(
  rows: readonly T[],
): (Omit<T, 'hoursTenths'> & HourBearingRow)[] {
  const collections = collectionIdsIn(rows);
  if (collections.size === 0) return [...rows];

  const membersByCollection = new Map<string, T[]>();
  for (const row of rows) {
    if (row.collectionId === null || row.collectionId === row.id) continue;
    const existing = membersByCollection.get(row.collectionId);
    if (existing) existing.push(row);
    else membersByCollection.set(row.collectionId, [row]);
  }

  return rows.map((row) => {
    if (!collections.has(row.id)) return row;
    const summary = rollUpHours(row, membersByCollection.get(row.id) ?? []);
    return summary.unsplit ? row : { ...row, hoursTenths: null };
  });
}

/**
 * Both roll-ups at once — what `listGameStatRows` applies at the read
 * boundary so that no stat builder has to remember either rule.
 */
export function collectionAdjustedRows<T extends CollectionRow & HourBearingRow & TrophyBearingRow>(
  rows: readonly T[],
) {
  // Return type left to inference: spelling the nested `Omit` out by hand is
  // what `tsc` refuses to unify, and the inferred shape is what callers need.
  return hoursAdjustedRows(trophyAdjustedRows(rows));
}
