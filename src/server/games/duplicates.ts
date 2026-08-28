/**
 * Duplicate detection and merge planning for the library.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO KINDS OF DUPLICATE, BOTH FROM THE OWNER'S REAL LIBRARY.
 *
 * 1. THE SAME GAME ON TWO PLATFORMS.
 *
 *      Uncharted: Legacy of Thieves Collection   PS4   42h    101      ★★★★★
 *      UNCHARTED: Legacy of Thieves Collection   PS5   42.9h  101/101  platinum
 *
 *    One purchase, played through backwards compatibility, reported by PSN
 *    under the platform it ran on. The near-identical hours are the tell: this
 *    is one playthrough recorded twice, not two.
 *
 *    `scripts/merge-duplicate-games.mjs` cannot see this pair at all — it keys
 *    on `platform + title`, so the two land in different groups. That is
 *    deliberate there and wrong here, which is why this module keys on TITLE
 *    ALONE and makes the platform an explicit decision on the merge instead.
 *
 * 2. A COLLECTION FLATTENED INTO ITS OWN FIRST TITLE.
 *
 *      Uncharted: The Nathan Drake Collection - Uncharted: Drake's Fortune…
 *      Uncharted™: The Nathan Drake Collection
 *
 *    The spreadsheet importer joined a collection's name to the first game
 *    listed under it, producing a row that is neither. It carries the SET's
 *    figures (44h, 154 achievements) under a name that reads like one title,
 *    which is exactly how 154 achievements ended up attributed to a single
 *    game. Detected by splitting on the separator and matching the left half.
 *
 * WHAT THIS MODULE REFUSES TO DECIDE. Merging deletes a row, so every case
 * where the right answer is not forced by the data becomes a `review` entry
 * naming what is ambiguous, never a guess. Three rows sharing a title, both
 * copies carrying a sync link, a row that holds collection members — each is
 * reported for the owner to resolve.
 *
 * Pure TypeScript. No React, no Next, no database — same boundary as the rest
 * of `src/server/games/`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { GamePlatform } from './taxonomy';

/** The projection duplicate detection needs. A structural type, so the DAL decides the query. */
export interface DuplicateCandidate {
  readonly id: string;
  readonly title: string;
  readonly platform: GamePlatform;
  readonly collectionId: string | null;
  readonly steamAppid: number | null;
  readonly psnTitleId: string | null;
  readonly psnNpCommunicationId: string | null;
  readonly ownership: string | null;
  readonly priceCents: number | null;
  readonly rating: number | null;
  readonly notes: string | null;
  readonly genre: string | null;
  readonly developer: string | null;
  readonly publisher: string | null;
  readonly coverUrl: string | null;
  readonly firstPlayedYear: number | null;
  readonly hoursTenths: number | null;
  readonly achievementsUnlocked: number | null;
  readonly achievementsTotal: number | null;
  readonly platinum: boolean;
  readonly metacritic: number | null;
}

/**
 * Columns a losing row can hand to the winner. `platinum` is deliberately
 * absent — it is a boolean, so "missing" and "false" are the same value and a
 * fill rule cannot tell them apart. It is OR-ed instead, below.
 *
 * `collectionId` is absent for a different reason: which set a row belongs to
 * is a relationship, not an attribute, and re-parenting is handled explicitly
 * by the merge rather than copied across as a field.
 */
export const FILLABLE_FIELDS = [
  'ownership',
  'priceCents',
  'rating',
  'notes',
  'genre',
  'developer',
  'publisher',
  'coverUrl',
  'firstPlayedYear',
  'hoursTenths',
  'achievementsUnlocked',
  'achievementsTotal',
  'metacritic',
] as const satisfies readonly (keyof DuplicateCandidate)[];

export type FillableField = (typeof FILLABLE_FIELDS)[number];

/**
 * The comparison key for "these are the same game".
 *
 * Folds everything a title picks up on its way through a spreadsheet, a
 * storefront and a PSN response: case, the curly apostrophe, trademark marks,
 * the various dashes, and runs of whitespace. It does NOT fold digits or
 * subtitle words — `Uncharted 2` and `Uncharted 3` must stay apart, which is
 * the same under-strip-never-over-strip rule merchant normalization follows in
 * Finance, and for the same reason: merging two different things moves data
 * between two rows the owner can see.
 */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replaceAll('’', "'")
    .replaceAll('™', '')
    .replaceAll('®', '')
    .replaceAll('©', '')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A row is linked to a provider — the copy a sync will keep rewriting, and so the one to keep. */
export function isSynced(row: DuplicateCandidate): boolean {
  return row.steamAppid !== null || row.psnTitleId !== null || row.psnNpCommunicationId !== null;
}

/**
 * The separator the spreadsheet importer left between a collection's name and
 * the title inside it. A spaced hyphen, never a bare one — "Ratchet-Clank"
 * and "Spider-Man" are single titles, and splitting on an unspaced hyphen
 * would tear them in half.
 */
const FLATTENED_SEPARATOR = ' - ';

/** The collection name a flattened row starts with, or `null` if it is not that shape. */
export function flattenedCollectionName(title: string): string | null {
  const index = title.indexOf(FLATTENED_SEPARATOR);
  if (index <= 0) return null;
  const left = title.slice(0, index).trim();
  return left === '' ? null : left;
}

/** The TITLE half of a flattened row — the game the collection name was glued to. */
export function flattenedMemberName(title: string): string | null {
  const index = title.indexOf(FLATTENED_SEPARATOR);
  if (index <= 0) return null;
  const right = title.slice(index + FLATTENED_SEPARATOR.length).trim();
  return right === '' ? null : right;
}

export type DuplicateKind = 'same-title' | 'flattened-collection';

export interface MergePlan {
  readonly kind: DuplicateKind;
  readonly winner: DuplicateCandidate;
  readonly loser: DuplicateCandidate;
  /** Values the loser carries that the winner is missing — applied to the winner on merge. */
  readonly fills: Readonly<Partial<Record<FillableField, unknown>>>;
  /** True when either row has it; the winner keeps it. */
  readonly platinum: boolean;
  /** Platforms in play. One entry when both rows agree; two when the merge has to choose. */
  readonly platforms: readonly GamePlatform[];
  /** Why this pair was proposed, in the owner's terms. */
  readonly reason: string;
  /**
   * A title the merge must CREATE inside the collection, or `null`.
   *
   * ───────────────────────────────────────────────────────────────────────────
   * WITHOUT THIS, MERGING A FLATTENED ROW SILENTLY LOSES A GAME FROM THE COUNT.
   *
   * "Uncharted: The Nathan Drake Collection - Uncharted: Drake's Fortune
   * Remastered" is a standalone row, so it counts as a game. Merge it into the
   * collection and it stops existing — the shelf goes from three Uncharted
   * titles to two, which is precisely the number the owner cares about and the
   * reason collections were built at all.
   *
   * The right-hand half of the flattened title is the missing game's name, so
   * the merge creates it and files it into the collection. It is created BARE:
   * hours and price belong to the set, and trophies stay unset until a sync
   * gives that title its own PSN list. See `rollUpTrophies`.
   * ───────────────────────────────────────────────────────────────────────────
   */
  readonly createsMember: string | null;
}

export interface DuplicateReview {
  readonly titles: readonly string[];
  readonly reason: string;
}

export interface DuplicateReport {
  readonly merges: readonly MergePlan[];
  readonly review: readonly DuplicateReview[];
}

/** Values on `from` that `onto` is missing. Never overwrites — a merge only ever fills gaps. */
export function fillsFor(
  onto: DuplicateCandidate,
  from: DuplicateCandidate,
): Readonly<Partial<Record<FillableField, unknown>>> {
  const fills: Partial<Record<FillableField, unknown>> = {};
  for (const field of FILLABLE_FIELDS) {
    if (onto[field] === null && from[field] !== null) fills[field] = from[field];
  }
  return fills;
}

/**
 * Which row survives.
 *
 * The synced copy wins: it is the one Steam or PSN will keep rewriting, so
 * keeping the other would mean the next sync re-creating this duplicate. When
 * neither or both are synced there is no forced answer and the caller sends
 * the pair to review rather than picking.
 */
function syncedWinner(a: DuplicateCandidate, b: DuplicateCandidate): DuplicateCandidate | null {
  if (isSynced(a) && !isSynced(b)) return a;
  if (isSynced(b) && !isSynced(a)) return b;
  return null;
}

function planPair(
  a: DuplicateCandidate,
  b: DuplicateCandidate,
  kind: DuplicateKind,
  holdsMembers: ReadonlySet<string>,
  hasTrophies: ReadonlySet<string>,
  forcedWinner?: DuplicateCandidate,
): MergePlan | DuplicateReview {
  const titles = [a.title, b.title];

  if (isSynced(a) && isSynced(b)) {
    return { titles, reason: 'Both copies are linked to a store — merging would drop one of the links.' };
  }

  const winner = forcedWinner ?? syncedWinner(a, b);
  if (winner === null) {
    return {
      titles,
      reason: 'Neither copy is linked to Steam or PSN, so there is no way to tell which one a sync will keep updating.',
    };
  }

  const loser = winner === a ? b : a;

  if (holdsMembers.has(loser.id)) {
    return { titles, reason: `"${loser.title}" holds games of its own — move them out before merging it away.` };
  }
  if (hasTrophies.has(loser.id)) {
    return {
      titles,
      reason: `"${loser.title}" has its own stored trophies, which would be deleted with it.`,
    };
  }

  const platforms = a.platform === b.platform ? [a.platform] : [winner.platform, loser.platform];

  // Only for a flattened row, and only when that name is not already in the
  // library — re-creating a title that exists would collide on the unique
  // (owner, title, platform) index, and more importantly would be wrong.
  const memberName = kind === 'flattened-collection' ? flattenedMemberName(loser.title) : null;

  return {
    kind,
    winner,
    loser,
    createsMember: memberName,
    fills: fillsFor(winner, loser),
    // OR-ed rather than filled: `false` is a real value, so a fill rule (which
    // only ever replaces `null`) can never carry a platinum across.
    platinum: a.platinum || b.platinum,
    platforms,
    reason:
      kind === 'flattened-collection'
        ? 'One row was imported with the collection name and its first game joined into a single title.'
        : platforms.length === 2
          ? 'Same title on two platforms — usually one purchase reported under the platform it was played on.'
          : 'Two rows with the same title on the same platform.',
  };
}

function isPlan(value: MergePlan | DuplicateReview): value is MergePlan {
  return 'winner' in value;
}

/**
 * Every duplicate this library appears to contain.
 *
 * `holdsMembers` and `hasTrophies` are supplied by the caller rather than
 * derived here, because only the first is derivable from `rows` — trophies
 * live in another table. Both exist to stop a merge deleting a row that other
 * data hangs off.
 */
export function findDuplicates(
  rows: readonly DuplicateCandidate[],
  options: {
    readonly holdsMembers?: ReadonlySet<string>;
    readonly hasTrophies?: ReadonlySet<string>;
  } = {},
): DuplicateReport {
  const holdsMembers = options.holdsMembers ?? new Set<string>();
  const hasTrophies = options.hasTrophies ?? new Set<string>();

  const merges: MergePlan[] = [];
  const review: DuplicateReview[] = [];
  // A row can look like both kinds of duplicate. It is only ever reported
  // once — a second card proposing a different merge for a row that has
  // already been merged away is a card that cannot work.
  const claimed = new Set<string>();

  const byKey = new Map<string, DuplicateCandidate[]>();
  for (const row of rows) {
    const key = titleKey(row.title);
    const existing = byKey.get(key);
    if (existing) existing.push(row);
    else byKey.set(key, [row]);
  }

  // ── 1. Flattened collection rows, first ──────────────────────────────────
  // Before same-title grouping, because a flattened row's own title is unique
  // and would never group with anything — and because its winner is FORCED
  // (the real collection), which is a stronger signal than sync status.
  for (const row of rows) {
    if (row.collectionId !== null) continue; // A row already inside a set is not a stray copy of one.
    const name = flattenedCollectionName(row.title);
    if (name === null) continue;

    const targets = (byKey.get(titleKey(name)) ?? []).filter((candidate) => candidate.id !== row.id);
    if (targets.length !== 1) continue; // No collection by that name, or several — not something to guess at.

    const collection = targets[0]!;
    if (claimed.has(row.id) || claimed.has(collection.id)) continue;

    const planned = planPair(collection, row, 'flattened-collection', holdsMembers, hasTrophies, collection);
    if (isPlan(planned)) {
      claimed.add(planned.winner.id);
      claimed.add(planned.loser.id);
      // Do not re-create a title the library already has — it would collide on
      // the unique (owner, title, platform) index, and the game is not missing.
      const alreadyPresent =
        planned.createsMember !== null && byKey.has(titleKey(planned.createsMember));
      merges.push(alreadyPresent ? { ...planned, createsMember: null } : planned);
    } else {
      claimed.add(row.id);
      claimed.add(collection.id);
      review.push(planned);
    }
  }

  // ── 2. Rows sharing a title, across platforms ────────────────────────────
  for (const [, group] of byKey) {
    const unclaimed = group.filter((row) => !claimed.has(row.id));
    if (unclaimed.length < 2) continue;

    if (unclaimed.length > 2) {
      review.push({
        titles: unclaimed.map((row) => row.title),
        reason: `${unclaimed.length} rows share this title — merging is only offered for a pair.`,
      });
      for (const row of unclaimed) claimed.add(row.id);
      continue;
    }

    const [a, b] = unclaimed as [DuplicateCandidate, DuplicateCandidate];
    const planned = planPair(a, b, 'same-title', holdsMembers, hasTrophies);
    claimed.add(a.id);
    claimed.add(b.id);
    if (isPlan(planned)) merges.push(planned);
    else review.push(planned);
  }

  return { merges, review };
}

/**
 * What each field is called on screen. The sentence below is read by the owner
 * immediately above a delete button, so it says "price" and "achievements",
 * not `priceCents` and `achievementsUnlocked` — a column name is an
 * implementation detail leaking into the one place that has to be
 * unambiguous.
 */
const FIELD_LABELS: Record<FillableField | 'platinum', string> = {
  ownership: 'ownership',
  priceCents: 'price',
  rating: 'rating',
  notes: 'notes',
  genre: 'genre',
  developer: 'developer',
  publisher: 'publisher',
  coverUrl: 'cover art',
  firstPlayedYear: 'year',
  hoursTenths: 'hours',
  achievementsUnlocked: 'achievements',
  achievementsTotal: 'achievement total',
  metacritic: 'Metacritic score',
  platinum: 'platinum',
};

/** Human-readable summary of what a merge carries across — the preview's one-line subtitle. */
export function describeFills(plan: MergePlan): string {
  const fields = Object.keys(plan.fills).map((field) => FIELD_LABELS[field as FillableField]);
  // Only when the merge is what SUPPLIES it — a winner that already has a
  // platinum gains nothing and should not be told it does.
  if (plan.platinum && !plan.winner.platinum) fields.push(FIELD_LABELS.platinum);

  if (fields.length === 0) return 'Nothing to carry over — the copy being removed adds no new detail.';
  return `Carries over ${fields.join(', ')}.`;
}
