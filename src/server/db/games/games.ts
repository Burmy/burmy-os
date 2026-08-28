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

import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, notInArray, or, sql } from 'drizzle-orm';

import { getDb } from '@/server/db';
import { games as gamesTable } from '@/server/db/schema';
import type { GameStatRow } from '@/server/games/stats';
import type { GameOwnership, GamePlatform, GameStatus } from '@/server/games/taxonomy';
import {
  DuplicateGameError,
  DuplicateWishlistGameError,
  GameNotFoundError,
  InvalidCollectionError,
  isUniqueViolation,
} from './errors';
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
  readonly steamAppid: number | null;
  readonly psnTitleId: string | null;
  readonly psnNpCommunicationId: string | null;
  readonly lastPlayedAt: Date | null;
  /** `YYYY-MM-DD` for a wishlisted game, else `null`. Read WITH `releasePrecision`, never alone. */
  readonly releaseDate: string | null;
  /** Whether `releaseDate`'s day is real or a `-01` placeholder — see `schema.ts`. */
  readonly releasePrecision: 'day' | 'month' | null;
  /** The collection this title belongs to, or `null` for a standalone game or a collection row itself. See `schema.ts`. */
  readonly collectionId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly playYears: readonly { readonly year: number; readonly hoursTenths: number }[];
}

/** Only `title` and `platform` are required — a backlog entry may know nothing else yet. */
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
  readonly steamAppid?: number | null;
  readonly psnTitleId?: string | null;
  readonly psnNpCommunicationId?: string | null;
  readonly lastPlayedAt?: Date | null;
  readonly collectionId?: string | null;
}

function rowToGame(
  row: typeof gamesTable.$inferSelect,
  playYears: readonly { readonly year: number; readonly hoursTenths: number }[],
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
    steamAppid: row.steamAppid,
    psnTitleId: row.psnTitleId,
    psnNpCommunicationId: row.psnNpCommunicationId,
    lastPlayedAt: row.lastPlayedAt,
    releaseDate: row.releaseDate,
    releasePrecision: row.releasePrecision,
    collectionId: row.collectionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    playYears,
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
      // ─────────────────────────────────────────────────────────────────────
      // RECENCY, PLATFORM-BLIND.
      //
      // This used to sort on `first_played_year` and then a deliberate
      // PS5 > PS4 > Steam/PC > PSP rank. Real usage rejected the platform
      // rank outright: the library should read as "what I have been playing,"
      // not as a console shelf.
      //
      // `last_played_at` alone could not do it. When this changed, only 74 of
      // 185 rows had one and every single one came from PSN, so sorting on it
      // would have produced PSN-then-everything-else — the exact grouping the
      // change set out to remove. Steam's `rtime_last_played` is now captured
      // too (`toOwnedGames` in `steam.ts`; it was always in the response, just
      // never parsed), and `first_played_year` covers the rest.
      //
      // TWO HONEST APPROXIMATIONS, neither fixable with the data available:
      //   1. A year-only game is ranked at 31 December of that year, so it
      //      sorts ABOVE exact-dated games from the same year. Ranking it at
      //      1 January would bury it under them instead; there is no correct
      //      answer, only a choice, and surfacing is the kinder one.
      //   2. `first_played_year` is FIRST played. A game first played in 2019
      //      and still being played today ranks as 2019 until a sync gives it
      //      a real `last_played_at`.
      //
      // `nulls last` is load-bearing: Postgres DESC defaults to NULLS FIRST,
      // which would float every never-played backlog entry above everything
      // actually played.
      // ─────────────────────────────────────────────────────────────────────
      sql`coalesce(${gamesTable.lastPlayedAt}, make_date(${gamesTable.firstPlayedYear}, 12, 31)) desc nulls last`,
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

  return rows.map((row) => rowToGame(row, byGame.get(row.id) ?? []));
}

export async function getGame(ownerId: string, id: string): Promise<Game> {
  const rows = await getDb()
    .select()
    .from(gamesTable)
    .where(and(eq(gamesTable.ownerId, ownerId), eq(gamesTable.id, id)))
    .limit(1);

  const row = rows[0];
  if (!row) throw new GameNotFoundError();
  const playYears = await listPlayYearsForGame(ownerId, row.id);
  return rowToGame(row, stripGameId(playYears));
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
    // This call only touches `games` columns — the play-year split (if any)
    // is unchanged by it, so reflect its actual current state rather than
    // reporting an empty split on a game that has one.
    const playYears = await listPlayYearsForGame(ownerId, row.id);
    return rowToGame(row, stripGameId(playYears));
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

  return rows.map((row) => ({
    ...row,
    platform: row.platform as GamePlatform,
    ownership: row.ownership as GameOwnership | null,
    status: row.status as GameStatus,
  }));
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
 * or since promoted to `backlog` by the auto-flip; either way, still the
 * SAME row the unique index on `(owner_id, igdb_id)` guards. Used by the
 * Upcoming tab to render an already-added candidate as "Added" instead of
 * offering the add control a second time.
 */
export async function listWishlistIgdbIds(ownerId: string): Promise<number[]> {
  const rows = await getDb()
    .select({ igdbId: gamesTable.igdbId })
    .from(gamesTable)
    .where(and(eq(gamesTable.ownerId, ownerId), isNotNull(gamesTable.igdbId)));

  return rows.map((row) => row.igdbId).filter((igdbId): igdbId is number => igdbId !== null);
}

/**
 * How many of the owner's wishlist rows have a `release_date` already in
 * the past. The Upcoming page counts this at render time and hands it down
 * so the client can decide whether to fire `promoteReleasedWantedGamesAction`
 * — see that action's own doc comment for why the flip itself can't happen
 * here, during a Server Component's render.
 */
export async function countOverdueWantedGames(ownerId: string): Promise<number> {
  const rows = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(gamesTable)
    .where(
      and(
        eq(gamesTable.ownerId, ownerId),
        eq(gamesTable.status, 'wanted'),
        sql`${gamesTable.releaseDate} < current_date`,
      ),
    );

  return rows[0]?.n ?? 0;
}

/**
 * `wanted` -> `backlog` for every one of the owner's wishlist rows whose
 * `release_date` has passed. Owner-scoped, and idempotent — a second call
 * touches zero rows once the first has already flipped everything overdue.
 * Returns the number of rows flipped, useful only for tests; callers don't
 * need it.
 */
export async function promoteReleasedWantedGames(ownerId: string): Promise<number> {
  const rows = await getDb()
    .update(gamesTable)
    .set({ status: 'backlog', updatedAt: new Date() })
    .where(
      and(
        eq(gamesTable.ownerId, ownerId),
        eq(gamesTable.status, 'wanted'),
        sql`${gamesTable.releaseDate} < current_date`,
      ),
    )
    .returning({ id: gamesTable.id });

  return rows.length;
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

// ─────────────────────────────────────────────────────────────────────────────
// Sync — shared scoping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A title INSIDE a collection is INVISIBLE to both sync engines.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY, AND WHAT BREAKS WITHOUT IT
 *
 * A collection ("Uncharted: The Nathan Drake Collection") is the row that
 * carries the Steam/PSN identity, the hours and the trophy list — it is the
 * only thing either API actually knows about. The individual titles inside
 * it ("Uncharted 2: Among Thieves Remastered") exist so the owner can count,
 * rate and illustrate them separately; no API will ever return one.
 *
 * Left visible to a sync, a child is matched BY NAME against the provider's
 * library like any other unlinked row — and `bestTitleMatchAmong` would
 * happily score "Uncharted 2: Among Thieves Remastered" against the
 * collection's own PSN played title. That stages a `link` change pointing a
 * child at its parent's `psnTitleId`, then `field_update`s flipping the
 * child's platform and overwriting its (deliberately empty) hours with the
 * collection's. The collection's real 44h would then exist twice, and the
 * counting rule in `stats.ts` would be summing it twice with it.
 *
 * This is the same failure mode — and the same fix — as the unlinked-PSP
 * guard in `resolvePlayedTitle` (`src/features/games/sync/psn-actions.ts`):
 * a row that can never have a genuine provider match must never reach the
 * name matcher at all. Declared ONCE here and applied at all four sync read
 * sites below rather than spelled out per query, because four is exactly the
 * number of places that is easy to update three of.
 *
 * A COLLECTION row itself is not excluded — `collection_id` is null on it,
 * so it syncs normally and is where every linked field belongs.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const NOT_A_COLLECTION_MEMBER = isNull(gamesTable.collectionId);

// ─────────────────────────────────────────────────────────────────────────────
// Steam sync (src/features/games/sync/sync-actions.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** The narrow projection the Steam sync engine needs to plan changes for one game. */
export interface SteamSyncGame {
  readonly id: string;
  readonly title: string;
  readonly steamAppid: number | null;
  readonly hoursTenths: number | null;
  readonly achievementsUnlocked: number | null;
  readonly achievementsTotal: number | null;
  readonly lastPlayedAt: Date | null;
}

/** How many Steam-platform games the owner has — a sync run's `total`. */
export async function countSteamGames(ownerId: string): Promise<number> {
  const rows = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(gamesTable)
    .where(and(eq(gamesTable.ownerId, ownerId), eq(gamesTable.platform, 'steam'), NOT_A_COLLECTION_MEMBER));

  return rows[0]?.n ?? 0;
}

/**
 * One page of the owner's Steam-platform games, KEYSET-paginated by `id` —
 * `afterId === null` starts from the beginning, otherwise only rows with
 * `id > afterId` are returned. Deliberately NOT offset/limit: `id` is a
 * random UUID (`defaultRandom()`), so an inserted row can sort anywhere,
 * and OFFSET counts row POSITIONS rather than tracking a specific row. A
 * game deleted before the offset shifts every later page left by one,
 * silently reprocessing or skipping a row; a game inserted before it does
 * the same in reverse. Keyset pagination has neither failure: it always
 * resumes from a specific id, not a position, so a mid-run insert or delete
 * elsewhere in the ordering cannot strand or duplicate anything. (An insert
 * whose id happens to sort BEFORE `afterId` is still missed until the next
 * run — see the sync engine's own doc comment.)
 *
 * Ordered STABLY BY `id` — not title, which can change mid-run and would
 * make a bookmark meaningless.
 */
export async function listSteamGamesChunk(
  ownerId: string,
  afterId: string | null,
  limit: number,
): Promise<SteamSyncGame[]> {
  const filters = [eq(gamesTable.ownerId, ownerId), eq(gamesTable.platform, 'steam'), NOT_A_COLLECTION_MEMBER];
  if (afterId !== null) filters.push(gt(gamesTable.id, afterId));

  return getDb()
    .select({
      id: gamesTable.id,
      title: gamesTable.title,
      steamAppid: gamesTable.steamAppid,
      hoursTenths: gamesTable.hoursTenths,
      achievementsUnlocked: gamesTable.achievementsUnlocked,
      achievementsTotal: gamesTable.achievementsTotal,
      lastPlayedAt: gamesTable.lastPlayedAt,
    })
    .from(gamesTable)
    .where(and(...filters))
    .orderBy(asc(gamesTable.id))
    .limit(limit);
}

/**
 * Every Steam-platform game's id/title/steamAppid, unpaged — the sync
 * engine's finalization step re-matches every one of these (not just the
 * ones in a given chunk) to decide which Steam-owned games genuinely have no
 * library counterpart. Staging never writes to `games`, so a title match
 * staged several chunks ago is still invisible in the `steamAppid` column;
 * recomputing the match here (pure, deterministic) is the only way to know.
 */
export async function listSteamGamesForMatching(
  ownerId: string,
): Promise<{ readonly id: string; readonly title: string; readonly steamAppid: number | null }[]> {
  return getDb()
    .select({ id: gamesTable.id, title: gamesTable.title, steamAppid: gamesTable.steamAppid })
    .from(gamesTable)
    .where(and(eq(gamesTable.ownerId, ownerId), eq(gamesTable.platform, 'steam'), NOT_A_COLLECTION_MEMBER));
}

// ─────────────────────────────────────────────────────────────────────────────
// PSN sync (src/features/games/sync/psn-actions.ts)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every PlayStation-platform game — `ps5`, `ps4`, AND `psp`. PSP is
 * deliberately included even though PSN's API can never return data for a
 * PSP title (it predates PSN's trophy system entirely): the sync engine must
 * walk every PSP row and find nothing to match, staging no change and
 * leaving the row completely untouched, rather than being special-cased out
 * as an "optimisation" that would leave the no-delete invariant unproven for
 * exactly the games the owner is most worried about. See
 * `tests/integration/games-psn-actions.test.ts`'s named invariant test.
 */
const PSN_PLATFORMS = ['ps5', 'ps4', 'psp'] as const;

/** The narrow projection the PSN sync engine needs to plan changes for one game. */
export interface PsnSyncGame {
  readonly id: string;
  readonly title: string;
  readonly platform: GamePlatform;
  readonly psnTitleId: string | null;
  readonly psnNpCommunicationId: string | null;
  readonly hoursTenths: number | null;
  readonly firstPlayedYear: number | null;
  /** ISO 8601, or `null` — converted from the stored `Date` here so `psn-plan.ts` stays a plain-string comparison. */
  readonly lastPlayedAt: string | null;
  readonly achievementsUnlocked: number | null;
  readonly achievementsTotal: number | null;
  readonly platinum: boolean;
}

function rowToPsnSyncGame(row: {
  readonly id: string;
  readonly title: string;
  readonly platform: string;
  readonly psnTitleId: string | null;
  readonly psnNpCommunicationId: string | null;
  readonly hoursTenths: number | null;
  readonly firstPlayedYear: number | null;
  readonly lastPlayedAt: Date | null;
  readonly achievementsUnlocked: number | null;
  readonly achievementsTotal: number | null;
  readonly platinum: boolean;
}): PsnSyncGame {
  return {
    id: row.id,
    title: row.title,
    platform: row.platform as GamePlatform,
    psnTitleId: row.psnTitleId,
    psnNpCommunicationId: row.psnNpCommunicationId,
    hoursTenths: row.hoursTenths,
    firstPlayedYear: row.firstPlayedYear,
    lastPlayedAt: row.lastPlayedAt ? row.lastPlayedAt.toISOString() : null,
    achievementsUnlocked: row.achievementsUnlocked,
    achievementsTotal: row.achievementsTotal,
    platinum: row.platinum,
  };
}

/** How many PlayStation-platform games the owner has — a sync run's `total`. */
export async function countPsnGames(ownerId: string): Promise<number> {
  const rows = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(gamesTable)
    .where(
      and(eq(gamesTable.ownerId, ownerId), inArray(gamesTable.platform, PSN_PLATFORMS), NOT_A_COLLECTION_MEMBER),
    );

  return rows[0]?.n ?? 0;
}

/**
 * One page of the owner's PlayStation-platform games, KEYSET-paginated by
 * `id` — identical rationale to `listSteamGamesChunk`'s own doc comment
 * (random UUID primary key, not a monotonic sequence; a mid-run insert or
 * delete can neither strand nor duplicate a keyset walk the way OFFSET/LIMIT
 * would).
 */
export async function listPsnGamesChunk(
  ownerId: string,
  afterId: string | null,
  limit: number,
): Promise<PsnSyncGame[]> {
  const filters = [
    eq(gamesTable.ownerId, ownerId),
    inArray(gamesTable.platform, PSN_PLATFORMS),
    NOT_A_COLLECTION_MEMBER,
  ];
  if (afterId !== null) filters.push(gt(gamesTable.id, afterId));

  const rows = await getDb()
    .select({
      id: gamesTable.id,
      title: gamesTable.title,
      platform: gamesTable.platform,
      psnTitleId: gamesTable.psnTitleId,
      psnNpCommunicationId: gamesTable.psnNpCommunicationId,
      hoursTenths: gamesTable.hoursTenths,
      firstPlayedYear: gamesTable.firstPlayedYear,
      lastPlayedAt: gamesTable.lastPlayedAt,
      achievementsUnlocked: gamesTable.achievementsUnlocked,
      achievementsTotal: gamesTable.achievementsTotal,
      platinum: gamesTable.platinum,
    })
    .from(gamesTable)
    .where(and(...filters))
    .orderBy(asc(gamesTable.id))
    .limit(limit);

  return rows.map(rowToPsnSyncGame);
}

/**
 * Every PlayStation-platform game's id/title/platform/psnTitleId, unpaged —
 * the PSN sync engine's finalization step re-matches every one of these (not
 * just the ones in a given chunk) to decide which PSN-owned played titles
 * genuinely have no library counterpart. Same reasoning as
 * `listSteamGamesForMatching`: staging never writes to `games`, so a title
 * match staged several chunks ago is still invisible in the `psnTitleId`
 * column here. `platform` is included so the caller can apply the same
 * "never name-match an unlinked PSP row" guard here that it applies in the
 * per-chunk loop — see `resolvePlayedTitle`'s doc comment in
 * `psn-actions.ts` for why.
 */
export async function listPsnGamesForMatching(
  ownerId: string,
): Promise<
  {
    readonly id: string;
    readonly title: string;
    readonly platform: GamePlatform;
    readonly psnTitleId: string | null;
  }[]
> {
  const rows = await getDb()
    .select({
      id: gamesTable.id,
      title: gamesTable.title,
      platform: gamesTable.platform,
      psnTitleId: gamesTable.psnTitleId,
    })
    .from(gamesTable)
    .where(
      and(eq(gamesTable.ownerId, ownerId), inArray(gamesTable.platform, PSN_PLATFORMS), NOT_A_COLLECTION_MEMBER),
    );

  return rows.map((row) => ({ ...row, platform: row.platform as GamePlatform }));
}
