/**
 * Owner-scoped data access for `game_trophies` — the per-trophy rows both
 * syncs now persist, and the four aggregate views the Stats page reads.
 *
 * Same rule as every other file here: `ownerId` first, in every `WHERE`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY AGGREGATE BELOW IS COMPUTED IN SQL, AT READ TIME. NOTHING IS STORED.
 *
 * Finance states this as a hard invariant ("never store a total" — CLAUDE.md);
 * Games holds the same line for the same reason. A stored completion percentage
 * is a number that can disagree with the rows it summarises, and the first sync
 * that half-succeeds is when it starts lying.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { and, eq, notInArray, sql } from 'drizzle-orm';

import { getDb } from '@/server/db';
import { gameTrophies, games as gamesTable } from '@/server/db/schema';
import type { Trophy, TrophySource, TrophyTier } from '@/server/games/trophies';

/** How many rows the ordered views return. Small on purpose — these are glanceable lists, not archives. */
const VIEW_LIMIT = 8;

/** A game is "nearly complete" at this fraction or above, short of finished. Used only by the completion summary's hint. */
const NEARLY_COMPLETE_RATIO = 0.9;

// ─────────────────────────────────────────────────────────────────────────────
// Writing (sync only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replaces one game's trophies with a freshly-synced set, in a transaction.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UPSERT, NOT DELETE-THEN-INSERT.
 *
 * `game_trophies_owner_game_source_external_idx` makes `(owner, game, source,
 * external_id)` unique, so a re-sync updates in place. Deleting first would
 * also work, and is wrong for one specific reason: a sync that failed partway
 * would leave the game with FEWER trophies than it really has, and the owner
 * would see a silently shrinking list. Upserting means an interrupted sync
 * leaves stale rows rather than missing ones.
 *
 * Rows are only removed when a trophy genuinely leaves the source's catalog —
 * the delete below, in the same transaction, targeting only ids the fresh
 * payload did not mention.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Called DIRECTLY by both sync engines, never through the propose-then-approve
 * staging that `hoursTenths`/`achievements*` go through. Those are fields the
 * owner can edit, so a sync proposes changes to them; an earned trophy is a
 * fact about the past that the owner cannot meaningfully overrule. Routing it
 * through review would be asking them to approve reality.
 */
export async function replaceGameTrophies(
  ownerId: string,
  gameId: string,
  source: TrophySource,
  trophies: readonly Trophy[],
): Promise<void> {
  // An empty set means the source told us nothing, never "this game has no
  // trophies any more" — returning early is what stops a failed fetch from
  // wiping a real list.
  if (trophies.length === 0) return;

  await getDb().transaction(async (tx) => {
    const now = new Date();

    await tx
      .insert(gameTrophies)
      .values(
        trophies.map((trophy) => ({
          ownerId,
          gameId,
          source,
          externalId: trophy.id,
          name: trophy.name,
          description: trophy.description,
          iconUrl: trophy.iconUrl,
          tier: trophy.tier,
          groupId: trophy.groupId,
          hidden: trophy.hidden,
          earned: trophy.earned,
          earnedAt: trophy.earnedAt === null ? null : new Date(trophy.earnedAt),
          rarityTenths: trophy.rarityTenths,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [gameTrophies.ownerId, gameTrophies.gameId, gameTrophies.source, gameTrophies.externalId],
        set: {
          name: sql`excluded.name`,
          description: sql`excluded.description`,
          iconUrl: sql`excluded.icon_url`,
          tier: sql`excluded.tier`,
          groupId: sql`excluded.group_id`,
          hidden: sql`excluded.hidden`,
          earned: sql`excluded.earned`,
          earnedAt: sql`excluded.earned_at`,
          rarityTenths: sql`excluded.rarity_tenths`,
          updatedAt: now,
        },
      });

    // Anything this source no longer defines for this game — a delisted DLC
    // trophy, say. Scoped to the same `source` so a PSN sync can never delete
    // Steam rows from a game that somehow carries both.
    const keep = trophies.map((trophy) => trophy.id);
    await tx
      .delete(gameTrophies)
      .where(
        and(
          eq(gameTrophies.ownerId, ownerId),
          eq(gameTrophies.gameId, gameId),
          eq(gameTrophies.source, source),
          // `notInArray`, not a raw `<> all(…)`: binding a JS array into raw
          // SQL sends it as a single opaque parameter, and Postgres rejects it
          // with "malformed array literal" unless it is cast. Drizzle's helper
          // expands the list properly and needs no cast at all.
          notInArray(gameTrophies.externalId, keep),
        ),
      );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading — the game page
// ─────────────────────────────────────────────────────────────────────────────

/** One game's stored trophies. The game page's entire trophy data source — no PSN call at render time. */
export async function listGameTrophies(ownerId: string, gameId: string): Promise<Trophy[]> {
  const rows = await getDb()
    .select()
    .from(gameTrophies)
    .where(and(eq(gameTrophies.ownerId, ownerId), eq(gameTrophies.gameId, gameId)));

  return rows.map((row) => ({
    source: row.source,
    id: row.externalId,
    groupId: row.groupId,
    tier: row.tier,
    hidden: row.hidden,
    name: row.name,
    description: row.description,
    iconUrl: row.iconUrl,
    earned: row.earned,
    earnedAt: row.earnedAt === null ? null : row.earnedAt.toISOString(),
    rarityTenths: row.rarityTenths,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading — the four Stats views
// ─────────────────────────────────────────────────────────────────────────────

export interface CloseToPlatinumRow {
  readonly gameId: string;
  readonly title: string;
  readonly coverUrl: string | null;
  readonly earned: number;
  readonly total: number;
  readonly remaining: number;
}

/**
 * Games with a platinum still to win, nearest first.
 *
 * PLAYSTATION ONLY, and not as an oversight: Steam has no platinum. A game
 * qualifies by actually defining an unearned `platinum` trophy rather than by
 * merely being under 100%, so a title with no platinum at all never appears —
 * you cannot be close to something that does not exist.
 *
 * Ordered by trophies REMAINING ascending, not by percentage. "3 left" is the
 * number that decides what you play tonight; 91% of a 200-trophy list is not
 * close at all.
 */
export async function listCloseToPlatinum(ownerId: string, limit: number = VIEW_LIMIT): Promise<CloseToPlatinumRow[]> {
  const rows = await getDb()
    .select({
      gameId: gameTrophies.gameId,
      title: gamesTable.title,
      coverUrl: gamesTable.coverUrl,
      earned: sql<number>`count(*) filter (where ${gameTrophies.earned})::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(gameTrophies)
    .innerJoin(gamesTable, eq(gamesTable.id, gameTrophies.gameId))
    .where(and(eq(gameTrophies.ownerId, ownerId), eq(gameTrophies.source, 'psn')))
    .groupBy(gameTrophies.gameId, gamesTable.title, gamesTable.coverUrl)
    .having(sql`bool_or(${gameTrophies.tier} = 'platinum' and not ${gameTrophies.earned})`)
    .orderBy(sql`count(*) filter (where not ${gameTrophies.earned}) asc`, sql`${gamesTable.title} asc`)
    .limit(limit);

  return rows.map((row) => ({ ...row, remaining: row.total - row.earned }));
}

export interface EarnedTrophyRow {
  readonly gameId: string;
  readonly gameTitle: string;
  readonly name: string | null;
  readonly tier: TrophyTier | null;
  readonly source: TrophySource;
  readonly earnedAt: string | null;
  readonly rarityTenths: number | null;
}

/** The most recent unlocks across BOTH sources — what you actually did lately, not what you own. */
export async function listRecentlyEarned(ownerId: string, limit: number = VIEW_LIMIT): Promise<EarnedTrophyRow[]> {
  const rows = await getDb()
    .select({
      gameId: gameTrophies.gameId,
      gameTitle: gamesTable.title,
      name: gameTrophies.name,
      tier: gameTrophies.tier,
      source: gameTrophies.source,
      earnedAt: gameTrophies.earnedAt,
      rarityTenths: gameTrophies.rarityTenths,
    })
    .from(gameTrophies)
    .innerJoin(gamesTable, eq(gamesTable.id, gameTrophies.gameId))
    // `earned_at` can be null even on an earned row — Steam reports
    // `unlocktime` 0 for some very old unlocks. A row with no date cannot be
    // placed on a timeline at all, so it is excluded rather than floated to
    // one end of it.
    .where(
      and(eq(gameTrophies.ownerId, ownerId), eq(gameTrophies.earned, true), sql`${gameTrophies.earnedAt} is not null`),
    )
    .orderBy(sql`${gameTrophies.earnedAt} desc`)
    .limit(limit);

  return rows.map((row) => ({ ...row, earnedAt: row.earnedAt === null ? null : row.earnedAt.toISOString() }));
}

/** Earned trophies the fewest other players have, rarest first. Both sources. */
export async function listRarestEarned(ownerId: string, limit: number = VIEW_LIMIT): Promise<EarnedTrophyRow[]> {
  const rows = await getDb()
    .select({
      gameId: gameTrophies.gameId,
      gameTitle: gamesTable.title,
      name: gameTrophies.name,
      tier: gameTrophies.tier,
      source: gameTrophies.source,
      earnedAt: gameTrophies.earnedAt,
      rarityTenths: gameTrophies.rarityTenths,
    })
    .from(gameTrophies)
    .innerJoin(gamesTable, eq(gamesTable.id, gameTrophies.gameId))
    .where(
      and(
        eq(gameTrophies.ownerId, ownerId),
        eq(gameTrophies.earned, true),
        sql`${gameTrophies.rarityTenths} is not null`,
      ),
    )
    .orderBy(sql`${gameTrophies.rarityTenths} asc`)
    .limit(limit);

  return rows.map((row) => ({ ...row, earnedAt: row.earnedAt === null ? null : row.earnedAt.toISOString() }));
}

export interface CompletionSummary {
  readonly earned: number;
  readonly total: number;
  /** 0-100, rounded. `null` when nothing is tracked at all — never 0, which would read as "you have earned nothing." */
  readonly percent: number | null;
  readonly trackedGames: number;
  readonly completeGames: number;
  readonly nearlyCompleteGames: number;
}

/**
 * Library-wide completion across BOTH sources — the one trophy number that
 * belongs beside Games and Hours on the stat-card row.
 *
 * Two queries rather than one: the headline figure is trophy-grained (every
 * trophy counts equally) while the game counts are game-grained (a 6-trophy
 * indie and a 60-trophy epic each count once). Deriving both from a single
 * aggregate would force one of those grains onto the other and quietly
 * misreport whichever lost.
 */
export async function getCompletionSummary(ownerId: string): Promise<CompletionSummary> {
  const [totals] = await getDb()
    .select({
      earned: sql<number>`count(*) filter (where ${gameTrophies.earned})::int`,
      total: sql<number>`count(*)::int`,
      trackedGames: sql<number>`count(distinct ${gameTrophies.gameId})::int`,
    })
    .from(gameTrophies)
    .where(eq(gameTrophies.ownerId, ownerId));

  const perGame = await getDb()
    .select({
      complete: sql<number>`count(*) filter (where ratio = 1)::int`,
      nearly: sql<number>`count(*) filter (where ratio >= ${NEARLY_COMPLETE_RATIO} and ratio < 1)::int`,
    })
    .from(
      getDb()
        .select({
          ratio: sql<number>`(count(*) filter (where ${gameTrophies.earned}))::float / count(*)`.as('ratio'),
        })
        .from(gameTrophies)
        .where(eq(gameTrophies.ownerId, ownerId))
        .groupBy(gameTrophies.gameId)
        .as('per_game'),
    );

  const earned = totals?.earned ?? 0;
  const total = totals?.total ?? 0;

  return {
    earned,
    total,
    percent: total === 0 ? null : Math.round((earned / total) * 100),
    trackedGames: totals?.trackedGames ?? 0,
    completeGames: perGame[0]?.complete ?? 0,
    nearlyCompleteGames: perGame[0]?.nearly ?? 0,
  };
}
