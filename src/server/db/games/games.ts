/**
 * Owner-scoped data access for `games`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `ownerId` IS THE FIRST PARAMETER OF EVERY FUNCTION AND GOES INTO EVERY WHERE.
 *
 * Same rule Finance's data-access layer follows. There is exactly one owner
 * today, which is precisely why the discipline has to be structural rather than
 * remembered: nothing about a single-owner database will fail loudly the day a
 * query forgets its scope.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';

import { getDb } from '@/server/db';
import { gameDlc, games as gamesTable } from '@/server/db/schema';
import { trophyAdjustedRows } from '@/server/games/collections';
import type { GameStatRow } from '@/server/games/stats';
import type { GameOwnership, GamePlatform, GameStatus } from '@/server/games/taxonomy';
import {
  DuplicateGameError,
  GameHasDlcError,
  DuplicateWishlistGameError,
  GameNotFoundError,
  InvalidCollectionError,
  isUniqueViolation,
} from './errors';
import { groupDlcByGame, type GameDlcRow } from '@/server/games/dlc';

import { listDlc, listDlcForGame } from './dlc';
import { listPlayYears, listPlayYearsForGame } from './play-years';

export interface Game {
  readonly id: string;
  readonly title: string;
  readonly platform: GamePlatform;
  readonly developer: string | null;
  readonly publisher: string | null;
  readonly ownership: GameOwnership | null;
  readonly priceCents: number | null;
  readonly status: GameStatus;
  readonly rating: number | null;
  readonly hoursTenths: number | null;
  readonly firstPlayedYear: number | null;
  readonly achievementsUnlocked: number | null;
  readonly achievementsTotal: number | null;
  readonly coverUrl: string | null;
  readonly genre: string | null;
  readonly notes: string | null;
  readonly platinum: boolean;
  readonly metacritic: number | null;
  readonly averagePlaytimeHours: number | null;
  readonly esrbRating: string | null;
  /** `YYYY-MM-DD` for a wishlisted game, else `null`. Read WITH `releasePrecision`, never alone. */
  readonly releaseDate: string | null;
  /** Whether `releaseDate`'s day is real or a `-01` placeholder — see `schema.ts`. */
  readonly releasePrecision: 'day' | 'month' | null;
  /** The collection this title belongs to, or `null` for a standalone game or a collection row itself. See `schema.ts`. */
  readonly collectionId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly playYears: readonly { readonly year: number; readonly hoursTenths: number }[];
  /**
   * The game's DLC rows, year then name. ADDITIVE to the base figures above —
   * see `src/server/games/dlc.ts` for `gameTotals`. Always `[]` for a
   * collection member (the DAL refuses the insert) and for a freshly created row.
   */
  readonly dlc: readonly GameDlcRow[];
}

/** Only `title` and `platform` are required — a freshly added game may know nothing else yet. */
export interface GameInput {
  readonly title: string;
  readonly platform: GamePlatform;
  readonly developer?: string | null;
  readonly publisher?: string | null;
  readonly ownership?: GameOwnership | null;
  readonly priceCents?: number | null;
  readonly status?: GameStatus;
  readonly rating?: number | null;
  readonly hoursTenths?: number | null;
  readonly firstPlayedYear?: number | null;
  readonly achievementsUnlocked?: number | null;
  readonly achievementsTotal?: number | null;
  readonly coverUrl?: string | null;
  readonly genre?: string | null;
  readonly notes?: string | null;
  readonly platinum?: boolean;
  readonly metacritic?: number | null;
  readonly averagePlaytimeHours?: number | null;
  readonly esrbRating?: string | null;
  /** Hand-entered from the panel (always `'day'` precision) — IGDB-sourced rows get theirs from `createWishlistGame`. */
  readonly releaseDate?: string | null;
  readonly releasePrecision?: 'day' | 'month' | null;
  readonly collectionId?: string | null;
}

function rowToGame(
  row: typeof gamesTable.$inferSelect,
  playYears: readonly { readonly year: number; readonly hoursTenths: number }[],
  dlc: readonly GameDlcRow[] = [],
): Game {
  return {
    id: row.id,
    title: row.title,
    platform: row.platform as GamePlatform,
    developer: row.developer,
    publisher: row.publisher,
    ownership: row.ownership as GameOwnership | null,
    priceCents: row.priceCents,
    status: row.status as GameStatus,
    rating: row.rating,
    hoursTenths: row.hoursTenths,
    firstPlayedYear: row.firstPlayedYear,
    achievementsUnlocked: row.achievementsUnlocked,
    achievementsTotal: row.achievementsTotal,
    coverUrl: row.coverUrl,
    genre: row.genre,
    notes: row.notes,
    platinum: row.platinum,
    metacritic: row.metacritic,
    averagePlaytimeHours: row.averagePlaytimeHours,
    esrbRating: row.esrbRating,
    releaseDate: row.releaseDate,
    releasePrecision: row.releasePrecision,
    collectionId: row.collectionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    playYears,
    dlc,
  };
}

export interface ListGamesOptions {
  readonly status?: GameStatus;
  readonly platform?: GamePlatform;
}

export async function listGames(ownerId: string, options: ListGamesOptions = {}): Promise<Game[]> {
  const filters = [eq(gamesTable.ownerId, ownerId)];
  if (options.status !== undefined) filters.push(eq(gamesTable.status, options.status));
  if (options.platform !== undefined) filters.push(eq(gamesTable.platform, options.platform));

  const rows = await getDb()
    .select()
    .from(gamesTable)
    .where(and(...filters))
    .orderBy(
      // LAST EDITED FIRST. The library reads as "what I last touched":
      // adding a game, changing its status, logging hours or fixing a typo
      // all move it to the front. Every write path sets `updated_at` by hand
      // (there is no DB trigger — see `updateGame`), so the column is a
      // reliable key for this. It replaced a `last_played_at` recency that
      // only the syncs ever filled; the column went with them. Platform
      // plays no part, deliberately — a console-shelf ordering was rejected
      // in real use.
      desc(gamesTable.updatedAt),
      asc(gamesTable.title),
    );

  // Single grouped query for every split the owner has, rather than one query
  // per game — see `listPlayYears`'s own doc comment ("the stats page's
  // single query"), which this reuses for the same reason.
  const splits = await listPlayYears(ownerId);
  const byGame = new Map<string, { year: number; hoursTenths: number }[]>();
  for (const row of splits) {
    const existing = byGame.get(row.gameId);
    if (existing === undefined)
      byGame.set(row.gameId, [{ year: row.year, hoursTenths: row.hoursTenths }]);
    else existing.push({ year: row.year, hoursTenths: row.hoursTenths });
  }

  // Same single-query shape for DLC — one grouped read, not one per game.
  const dlcByGame = groupDlcByGame(await listDlc(ownerId));

  return rows.map((row) => rowToGame(row, byGame.get(row.id) ?? [], dlcByGame.get(row.id) ?? []));
}

export async function getGame(ownerId: string, id: string): Promise<Game> {
  const rows = await getDb()
    .select()
    .from(gamesTable)
    .where(and(eq(gamesTable.ownerId, ownerId), eq(gamesTable.id, id)))
    .limit(1);

  const row = rows[0];
  if (!row) throw new GameNotFoundError();
  const [playYears, dlc] = await Promise.all([
    listPlayYearsForGame(ownerId, row.id),
    listDlcForGame(ownerId, row.id),
  ]);
  return rowToGame(row, stripGameId(playYears), dlc);
}

/**
 * `listPlayYearsForGame` returns the full `PlayYearRow` shape (it also
 * carries `gameId`, useful to `listPlayYears`' bulk caller in `listGames`).
 * `Game.playYears` is declared narrower — `{ year, hoursTenths }` only, since
 * every entry already belongs to the one game it hangs off — so this strips
 * the redundant `gameId` rather than let it leak through as an unlisted
 * extra property on every single-game fetch.
 */
function stripGameId(
  rows: readonly { readonly year: number; readonly hoursTenths: number }[],
): { readonly year: number; readonly hoursTenths: number }[] {
  return rows.map((row) => ({ year: row.year, hoursTenths: row.hoursTenths }));
}

export async function createGame(ownerId: string, input: GameInput): Promise<Game> {
  try {
    const rows = await getDb()
      .insert(gamesTable)
      .values({ ownerId, ...input })
      .returning();

    const row = rows[0];
    if (!row) throw new Error('Game insert returned no row');
    // A brand-new row has no play-year split yet — nothing to query.
    return rowToGame(row, []);
  } catch (error) {
    // Let the DATABASE decide uniqueness. A pre-check plus an insert is a race;
    // the unique index is not.
    if (isUniqueViolation(error)) throw new DuplicateGameError(input.title);
    throw error;
  }
}

export async function updateGame(ownerId: string, id: string, input: GameInput): Promise<Game> {
  try {
    const rows = await getDb()
      .update(gamesTable)
      // `updatedAt` is set by hand on every write — there is no DB trigger.
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(gamesTable.ownerId, ownerId), eq(gamesTable.id, id)))
      .returning();

    const row = rows[0];
    if (!row) throw new GameNotFoundError();
    // This call only touches `games` columns — the play-year split and the
    // DLC rows (if any) are unchanged by it, so reflect their actual current
    // state rather than reporting them empty on a game that has them.
    const [playYears, dlc] = await Promise.all([
      listPlayYearsForGame(ownerId, row.id),
      listDlcForGame(ownerId, row.id),
    ]);
    return rowToGame(row, stripGameId(playYears), dlc);
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateGameError(input.title);
    throw error;
  }
}

export async function deleteGame(ownerId: string, id: string): Promise<void> {
  const deleted = await getDb()
    .delete(gamesTable)
    .where(and(eq(gamesTable.ownerId, ownerId), eq(gamesTable.id, id)))
    .returning();

  if (!deleted[0]) throw new GameNotFoundError();
}

/**
 * The narrow projection `src/server/games/stats.ts` consumes. Selecting columns
 * explicitly rather than reusing `listGames` keeps the stats layer's input
 * shape from silently widening every time a display field is added.
 */
/**
 * The read boundary every stat function shares. `wanted` rows are wishlist
 * entries, not owned games — they must never contribute to a library
 * total, average, count, or leaderboard. Filtered ONCE, here, rather than in
 * each of `buildLibrarySummary`/`buildYearlyBreakdown`/`buildDistribution`/
 * `findCallouts`/`buildFinancialSummary`/`buildLeaderboard` individually:
 * six call sites is six chances to forget one, and a stat function added
 * later would silently miss the exclusion. Filtering at this single query
 * boundary makes every current and future stat correct by construction. See
 * CLAUDE.md and the plan's "The two consequences of `wanted` being a real
 * status."
 */
export async function listGameStatRows(ownerId: string): Promise<GameStatRow[]> {
  const rows = await getDb()
    .select({
      id: gamesTable.id,
      title: gamesTable.title,
      platform: gamesTable.platform,
      ownership: gamesTable.ownership,
      developer: gamesTable.developer,
      publisher: gamesTable.publisher,
      genre: gamesTable.genre,
      coverUrl: gamesTable.coverUrl,
      status: gamesTable.status,
      rating: gamesTable.rating,
      hoursTenths: gamesTable.hoursTenths,
      firstPlayedYear: gamesTable.firstPlayedYear,
      achievementsUnlocked: gamesTable.achievementsUnlocked,
      achievementsTotal: gamesTable.achievementsTotal,
      platinum: gamesTable.platinum,
      metacritic: gamesTable.metacritic,
      priceCents: gamesTable.priceCents,
      // Carried through so the pure stats layer can tell a COLLECTION row
      // apart from the titles inside it — see `playableRows` in
      // `src/server/games/stats.ts`. Deliberately not resolved to an
      // `isCollection` boolean here: that derivation is one line over the
      // rows this query already returns, and keeping it in `stats.ts` keeps
      // it unit-testable without a database, per that module's own charter.
      collectionId: gamesTable.collectionId,
    })
    .from(gamesTable)
    .where(and(eq(gamesTable.ownerId, ownerId), ne(gamesTable.status, 'wanted')));

  // TROPHIES ARE ADJUSTED HERE, AT THE SAME BOUNDARY `wanted` IS FILTERED,
  // and for the same reason its own doc comment gives: six call sites is six
  // chances to forget one, and a stat function added later would silently
  // miss the rule. A collection whose members carry their own trophies stops
  // contributing its (now superseded) lump, so no achievement is counted
  // twice — see `trophyAdjustedRows` for the double-count this prevents.
  //
  // HOURS AND MONEY ARE NOT TOUCHED. A member carries NULL for both, so those
  // sums are already correct and the collection is genuinely where they live.
  return trophyAdjustedRows(
    rows.map((row) => ({
      ...row,
      platform: row.platform as GamePlatform,
      ownership: row.ownership as GameOwnership | null,
      status: row.status as GameStatus,
    })),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Upcoming games / wishlist (src/features/games/upcoming/wishlist-actions.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** What `addToWishlistAction` needs to create a `wanted` row from an IGDB "Upcoming games" candidate. */
export interface WishlistGameInput {
  readonly igdbId: number;
  readonly title: string;
  readonly coverUrl: string | null;
  /** `YYYY-MM-DD`, or `null` for a Later/TBD candidate — see `UpcomingMonthGame.releaseDate`. */
  readonly releaseDate: string | null;
  /** `null` exactly when `releaseDate` is. Persisting this is what lets the card count down honestly. */
  readonly releasePrecision: 'day' | 'month' | null;
  readonly platform: GamePlatform;
}

/**
 * Creates a `wanted` (wishlist) row. A dedicated insert, not a call to
 * `createGame`: the two functions guard two DIFFERENT unique indexes
 * (`games_owner_title_platform_idx` vs. `games_owner_igdb_id_idx`), and a
 * shared `isUniqueViolation()` catch has no way to tell which one fired —
 * this keeps the resulting error message honest about which collision
 * actually happened, rather than reusing `DuplicateGameError`'s
 * title+platform wording ("the same game on a different platform is fine")
 * for a conflict that is actually about the IGDB id.
 */
export async function createWishlistGame(ownerId: string, input: WishlistGameInput): Promise<Game> {
  try {
    const rows = await getDb()
      .insert(gamesTable)
      .values({
        ownerId,
        title: input.title,
        platform: input.platform,
        status: 'wanted',
        coverUrl: input.coverUrl,
        releaseDate: input.releaseDate,
        releasePrecision: input.releasePrecision,
        igdbId: input.igdbId,
      })
      .returning();

    const row = rows[0];
    if (!row) throw new Error('Wishlist game insert returned no row');
    // A brand-new wishlist row has no play-year split — nothing to query.
    return rowToGame(row, []);
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateWishlistGameError(input.title);
    throw error;
  }
}

/**
 * Every IGDB game id the owner already has a `games` row for — wishlisted,
 * or since moved to another status; either way, still the SAME row the
 * unique index on `(owner_id, igdb_id)` guards. The Upcoming page drops
 * these from the IGDB feed (`excludeOwned`): a wishlisted game is listed in
 * "Your wishlist" above it, and an owned one has nothing to add.
 */
export async function listWishlistIgdbIds(ownerId: string): Promise<number[]> {
  const rows = await getDb()
    .select({ igdbId: gamesTable.igdbId })
    .from(gamesTable)
    .where(and(eq(gamesTable.ownerId, ownerId), isNotNull(gamesTable.igdbId)));

  return rows.map((row) => row.igdbId).filter((igdbId): igdbId is number => igdbId !== null);
}

/** One wishlist row's stored release date, keyed by IGDB id — the input to a reconcile. */
export interface WantedReleaseDate {
  readonly igdbId: number;
  readonly releaseDate: string | null;
  readonly releasePrecision: 'day' | 'month' | null;
}

/** Every `wanted` row that came from the Upcoming flow, i.e. has an IGDB id to match on. */
export async function listWantedReleaseDates(ownerId: string): Promise<WantedReleaseDate[]> {
  const rows = await getDb()
    .select({
      igdbId: gamesTable.igdbId,
      releaseDate: gamesTable.releaseDate,
      releasePrecision: gamesTable.releasePrecision,
    })
    .from(gamesTable)
    .where(
      and(
        eq(gamesTable.ownerId, ownerId),
        eq(gamesTable.status, 'wanted'),
        isNotNull(gamesTable.igdbId),
      ),
    );

  return rows.flatMap((row) => (row.igdbId === null ? [] : [{ ...row, igdbId: row.igdbId }]));
}

/**
 * Corrects one wishlist row's release date from a fresh IGDB reading.
 *
 * Scoped to `status = 'wanted'` in the WHERE clause, not just at the caller: a
 * game the owner has since marked owned is no longer a wishlist row and its
 * date must not be rewritten by a background reconcile it never asked for. The
 * `igdb_id` match is exact — `games_owner_igdb_id_idx` makes it unique per
 * owner — so this can never touch more than one row.
 */
export async function updateWantedReleaseDate(
  ownerId: string,
  igdbId: number,
  releaseDate: string,
  releasePrecision: 'day' | 'month',
): Promise<void> {
  await getDb()
    .update(gamesTable)
    .set({ releaseDate, releasePrecision, updatedAt: new Date() })
    .where(
      and(
        eq(gamesTable.ownerId, ownerId),
        eq(gamesTable.igdbId, igdbId),
        eq(gamesTable.status, 'wanted'),
      ),
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Collections
// ─────────────────────────────────────────────────────────────────────────────

/** One title inside a collection, as the collection's own page lists them. */
export interface CollectionMember {
  readonly id: string;
  readonly title: string;
  readonly coverUrl: string | null;
  readonly platform: GamePlatform;
  readonly status: GameStatus;
  readonly rating: number | null;
  readonly firstPlayedYear: number | null;
  /**
   * A member's OWN trophies. Carried because trophies, unlike hours and price,
   * genuinely belong to the individual title — PSN gives the Nathan Drake
   * Collection three separate trophy lists and one cumulative playDuration.
   * The collection's page sums these; see `rollUpTrophies`.
   */
  readonly achievementsUnlocked: number | null;
  readonly achievementsTotal: number | null;
  readonly platinum: boolean;
}

/** The games inside one collection, alphabetical — a boxed set has a running order, but the database does not know it. */
export async function listCollectionMembers(
  ownerId: string,
  collectionId: string,
): Promise<CollectionMember[]> {
  const rows = await getDb()
    .select({
      id: gamesTable.id,
      title: gamesTable.title,
      coverUrl: gamesTable.coverUrl,
      platform: gamesTable.platform,
      status: gamesTable.status,
      rating: gamesTable.rating,
      firstPlayedYear: gamesTable.firstPlayedYear,
      achievementsUnlocked: gamesTable.achievementsUnlocked,
      achievementsTotal: gamesTable.achievementsTotal,
      platinum: gamesTable.platinum,
    })
    .from(gamesTable)
    .where(and(eq(gamesTable.ownerId, ownerId), eq(gamesTable.collectionId, collectionId)))
    .orderBy(asc(gamesTable.title));

  return rows.map((row) => ({
    ...row,
    platform: row.platform as GamePlatform,
    status: row.status as GameStatus,
  }));
}

/**
 * The rows a game may be filed INTO, for the editor's picker.
 *
 * Anything that is not itself already inside a collection, minus the game
 * being edited — i.e. exactly the set `assertCollectionTargetValid` below
 * will accept, so the picker can never offer a choice the server refuses.
 * Deliberately includes ordinary standalone games, not just rows that
 * already have members: a collection comes into existence the moment the
 * first game is filed into one, and requiring a separate "make this a
 * collection" step first would be a mode for no reason.
 */
export async function listCollectionOptions(
  ownerId: string,
  excludeGameId: string,
): Promise<{ readonly id: string; readonly title: string }[]> {
  return getDb()
    .select({ id: gamesTable.id, title: gamesTable.title })
    .from(gamesTable)
    .where(
      and(
        eq(gamesTable.ownerId, ownerId),
        isNull(gamesTable.collectionId),
        ne(gamesTable.id, excludeGameId),
      ),
    )
    .orderBy(asc(gamesTable.title));
}

/**
 * Refuses a `collection_id` that would break the one-level rule — see
 * `InvalidCollectionError` for the three cases. Owner-scoped throughout: a
 * target belonging to someone else is simply not found, and reads as an
 * ordinary not-found rather than confirming it exists.
 */
async function assertCollectionTargetValid(
  ownerId: string,
  gameId: string,
  collectionId: string,
): Promise<void> {
  if (collectionId === gameId) throw new InvalidCollectionError('self');

  const [target] = await getDb()
    .select({ id: gamesTable.id, collectionId: gamesTable.collectionId })
    .from(gamesTable)
    .where(and(eq(gamesTable.ownerId, ownerId), eq(gamesTable.id, collectionId)))
    .limit(1);

  if (!target) throw new GameNotFoundError();
  if (target.collectionId !== null) throw new InvalidCollectionError('target-is-member');

  // Moving a row that already holds games INTO another collection would bury
  // its own members two levels deep, where no view renders them.
  const [ownMember] = await getDb()
    .select({ id: gamesTable.id })
    .from(gamesTable)
    .where(and(eq(gamesTable.ownerId, ownerId), eq(gamesTable.collectionId, gameId)))
    .limit(1);

  if (ownMember) throw new InvalidCollectionError('already-a-collection');

  // A member carries no hours, price or trophies of its own, and so cannot
  // carry DLC either (`errors.ts`, `GameHasDlcError`). The owner moves the
  // DLC to the collection first, then files the game.
  const [ownDlc] = await getDb()
    .select({ id: gameDlc.id })
    .from(gameDlc)
    .where(and(eq(gameDlc.ownerId, ownerId), eq(gameDlc.gameId, gameId)))
    .limit(1);

  if (ownDlc) throw new GameHasDlcError();
}

/**
 * Files a game into a collection, or takes it out of one (`null`).
 *
 * Removing a game from its collection does NOT give it back the hours, price
 * or trophies that live on the collection — those were never its own. It
 * simply becomes an ordinary standalone entry again, which is the same thing
 * `ON DELETE SET NULL` does when a collection is deleted outright.
 */
export async function setGameCollection(
  ownerId: string,
  gameId: string,
  collectionId: string | null,
): Promise<void> {
  if (collectionId !== null) await assertCollectionTargetValid(ownerId, gameId, collectionId);

  const updated = await getDb()
    .update(gamesTable)
    .set({ collectionId, updatedAt: new Date() })
    .where(and(eq(gamesTable.ownerId, ownerId), eq(gamesTable.id, gameId)))
    .returning({ id: gamesTable.id });

  if (!updated[0]) throw new GameNotFoundError();
}

/**
 * Files SEVERAL games into one collection at once — the collection page's
 * "Add games" picker and the library's multi-select both land here.
 *
 * Every id is validated against the same one-level rule a single filing goes
 * through, and the whole batch is one transaction: filing eight games and
 * having the fifth fail must not leave four filed and four not, with no
 * indication of where it stopped. Either the set the owner picked is in, or
 * nothing moved and the error names the game that blocked it.
 *
 * Already-filed rows are not an error and are not rewritten — re-adding a
 * game that is already in this collection is a no-op, so the picker can show
 * current members as checked without every confirm re-writing them.
 */
export async function setCollectionForGames(
  ownerId: string,
  gameIds: readonly string[],
  collectionId: string,
): Promise<number> {
  if (gameIds.length === 0) return 0;

  for (const gameId of gameIds) {
    await assertCollectionTargetValid(ownerId, gameId, collectionId);
  }

  const updated = await getDb()
    .update(gamesTable)
    .set({ collectionId, updatedAt: new Date() })
    .where(
      and(
        eq(gamesTable.ownerId, ownerId),
        inArray(gamesTable.id, [...gameIds]),
        // `IS DISTINCT FROM`, not `<>` — a NULL `collection_id` (the normal
        // case for a game being filed for the first time) makes `<>` NULL,
        // which is not true, and the row would never be updated at all.
        sql`${gamesTable.collectionId} is distinct from ${collectionId}`,
      ),
    )
    .returning({ id: gamesTable.id });

  return updated.length;
}

/**
 * Games that could be added to `collectionId` — the "Add games" picker's list.
 *
 * Three exclusions, each for its own reason:
 *   · the collection itself       — a row cannot contain itself
 *   · rows already inside ANOTHER collection — moving one silently out of the
 *     set it is in is not what "add" means; the owner removes it there first
 *   · rows that hold games of their own — the one-level rule
 *
 * Rows already in THIS collection are deliberately included, so the picker can
 * render them checked rather than making the current members invisible.
 */
export async function listCollectionCandidates(
  ownerId: string,
  collectionId: string,
): Promise<{ readonly id: string; readonly title: string; readonly platform: GamePlatform }[]> {
  const holdsGames = getDb()
    .select({ id: gamesTable.collectionId })
    .from(gamesTable)
    .where(and(eq(gamesTable.ownerId, ownerId), isNotNull(gamesTable.collectionId)));

  return getDb()
    .select({ id: gamesTable.id, title: gamesTable.title, platform: gamesTable.platform })
    .from(gamesTable)
    .where(
      and(
        eq(gamesTable.ownerId, ownerId),
        ne(gamesTable.id, collectionId),
        or(isNull(gamesTable.collectionId), eq(gamesTable.collectionId, collectionId)),
        notInArray(gamesTable.id, holdsGames),
      ),
    )
    .orderBy(asc(gamesTable.title));
}
