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

import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';

import { getDb } from '@/server/db';
import { games as gamesTable } from '@/server/db/schema';
import type { GameStatRow } from '@/server/games/stats';
import type { GameOwnership, GamePlatform, GameStatus } from '@/server/games/taxonomy';
import { DuplicateGameError, GameNotFoundError, isUniqueViolation } from './errors';
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
      // Newest-played first. Postgres's DESC defaults to NULLS FIRST, which
      // would put every game with no recorded year — an unplayed backlog
      // entry — ABOVE everything the owner has actually played. `nulls last`
      // is load-bearing here, not decorative.
      sql`${gamesTable.firstPlayedYear} desc nulls last`,
      // ─────────────────────────────────────────────────────────────────────
      // DELIBERATE, OWNER-CHOSEN PLATFORM ORDER — NOT ALPHABETICAL.
      //
      // Only breaks ties among games with NO recorded year (the `when
      // first_played_year is null` guard): for every game that DOES have a
      // year, this branch collapses to the constant `0` and falls straight
      // through to the title tiebreak below, exactly as before. Within the
      // no-year group, rank is PS5, PS4, Steam/PC (steam and pc share a rank
      // — they render as one merged label, see PLATFORM_LABELS), PSP, then
      // anything else. Do not "tidy" this into alphabetical order or enum
      // order — it encodes a real product decision the owner asked for.
      // ─────────────────────────────────────────────────────────────────────
      sql`case when ${gamesTable.firstPlayedYear} is null then
        case ${gamesTable.platform}::text
          when 'ps5' then 0
          when 'ps4' then 1
          when 'steam' then 2
          when 'pc' then 2
          when 'psp' then 3
          else 4
        end
      else 0 end`,
      asc(gamesTable.title),
    );

  // Single grouped query for every split the owner has, rather than one query
  // per game — see `listPlayYears`'s own doc comment ("the stats page's
  // single query"), which this reuses for the same reason.
  const splits = await listPlayYears(ownerId);
  const byGame = new Map<string, { year: number; hoursTenths: number }[]>();
  for (const row of splits) {
    const existing = byGame.get(row.gameId);
    if (existing === undefined) byGame.set(row.gameId, [{ year: row.year, hoursTenths: row.hoursTenths }]);
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
    })
    .from(gamesTable)
    .where(eq(gamesTable.ownerId, ownerId));

  return rows.map((row) => ({
    ...row,
    platform: row.platform as GamePlatform,
    ownership: row.ownership as GameOwnership | null,
    status: row.status as GameStatus,
  }));
}

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
}

/** How many Steam-platform games the owner has — a sync run's `total`. */
export async function countSteamGames(ownerId: string): Promise<number> {
  const rows = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(gamesTable)
    .where(and(eq(gamesTable.ownerId, ownerId), eq(gamesTable.platform, 'steam')));

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
export async function listSteamGamesChunk(ownerId: string, afterId: string | null, limit: number): Promise<SteamSyncGame[]> {
  const filters = [eq(gamesTable.ownerId, ownerId), eq(gamesTable.platform, 'steam')];
  if (afterId !== null) filters.push(gt(gamesTable.id, afterId));

  return getDb()
    .select({
      id: gamesTable.id,
      title: gamesTable.title,
      steamAppid: gamesTable.steamAppid,
      hoursTenths: gamesTable.hoursTenths,
      achievementsUnlocked: gamesTable.achievementsUnlocked,
      achievementsTotal: gamesTable.achievementsTotal,
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
    .where(and(eq(gamesTable.ownerId, ownerId), eq(gamesTable.platform, 'steam')));
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
    .where(and(eq(gamesTable.ownerId, ownerId), inArray(gamesTable.platform, PSN_PLATFORMS)));

  return rows[0]?.n ?? 0;
}

/**
 * One page of the owner's PlayStation-platform games, KEYSET-paginated by
 * `id` — identical rationale to `listSteamGamesChunk`'s own doc comment
 * (random UUID primary key, not a monotonic sequence; a mid-run insert or
 * delete can neither strand nor duplicate a keyset walk the way OFFSET/LIMIT
 * would).
 */
export async function listPsnGamesChunk(ownerId: string, afterId: string | null, limit: number): Promise<PsnSyncGame[]> {
  const filters = [eq(gamesTable.ownerId, ownerId), inArray(gamesTable.platform, PSN_PLATFORMS)];
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
  { readonly id: string; readonly title: string; readonly platform: GamePlatform; readonly psnTitleId: string | null }[]
> {
  const rows = await getDb()
    .select({ id: gamesTable.id, title: gamesTable.title, platform: gamesTable.platform, psnTitleId: gamesTable.psnTitleId })
    .from(gamesTable)
    .where(and(eq(gamesTable.ownerId, ownerId), inArray(gamesTable.platform, PSN_PLATFORMS)));

  return rows.map((row) => ({ ...row, platform: row.platform as GamePlatform }));
}
