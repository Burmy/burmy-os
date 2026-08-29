/**
 * Reading duplicate candidates, and the one write in this app that DELETES a
 * game row.
 *
 * Everything here is owner-scoped in the same way the rest of `db/games`
 * is — `ownerId` in every WHERE, including on the delete, so a merge can never
 * reach across accounts even if an id were guessed.
 */

import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';

import { getDb } from '@/server/db';
import { gameTrophies, games as gamesTable } from '@/server/db/schema';
import type { DuplicateCandidate, FillableField } from '@/server/games/duplicates';
import type { GamePlatform } from '@/server/games/taxonomy';
import { GameNotFoundError } from './errors';

/**
 * Every row duplicate detection looks at, plus the two facts it cannot derive
 * from the rows themselves.
 *
 * `wanted` rows are EXCLUDED. A wishlist entry naturally shares its title with
 * the owned copy once a game is bought — that is the wishlist working, not a
 * duplicate, and offering to merge the two would delete the record of what was
 * wanted.
 */
export async function listDuplicateCandidates(ownerId: string): Promise<{
  readonly rows: DuplicateCandidate[];
  readonly holdsMembers: ReadonlySet<string>;
  readonly hasTrophies: ReadonlySet<string>;
}> {
  const db = getDb();

  const [rows, memberParents, trophyOwners] = await Promise.all([
    db
      .select({
        id: gamesTable.id,
        title: gamesTable.title,
        platform: gamesTable.platform,
        collectionId: gamesTable.collectionId,
        steamAppid: gamesTable.steamAppid,
        psnTitleId: gamesTable.psnTitleId,
        psnNpCommunicationId: gamesTable.psnNpCommunicationId,
        ownership: gamesTable.ownership,
        priceCents: gamesTable.priceCents,
        rating: gamesTable.rating,
        notes: gamesTable.notes,
        genre: gamesTable.genre,
        developer: gamesTable.developer,
        publisher: gamesTable.publisher,
        coverUrl: gamesTable.coverUrl,
        firstPlayedYear: gamesTable.firstPlayedYear,
        hoursTenths: gamesTable.hoursTenths,
        achievementsUnlocked: gamesTable.achievementsUnlocked,
        achievementsTotal: gamesTable.achievementsTotal,
        platinum: gamesTable.platinum,
        metacritic: gamesTable.metacritic,
      })
      .from(gamesTable)
      .where(and(eq(gamesTable.ownerId, ownerId), ne(gamesTable.status, 'wanted'))),

    db
      .selectDistinct({ id: gamesTable.collectionId })
      .from(gamesTable)
      .where(and(eq(gamesTable.ownerId, ownerId), isNotNull(gamesTable.collectionId))),

    db
      .selectDistinct({ id: gameTrophies.gameId })
      .from(gameTrophies)
      .where(eq(gameTrophies.ownerId, ownerId)),
  ]);

  return {
    rows: rows.map((row) => ({ ...row, platform: row.platform as GamePlatform })),
    holdsMembers: new Set(memberParents.map((row) => row.id).filter((id): id is string => id !== null)),
    hasTrophies: new Set(trophyOwners.map((row) => row.id)),
  };
}

/** Columns a merge may write onto the winner — mirrors `FILLABLE_FIELDS`, which is the pure module's own list. */
const WRITABLE = {
  ownership: gamesTable.ownership,
  priceCents: gamesTable.priceCents,
  rating: gamesTable.rating,
  notes: gamesTable.notes,
  genre: gamesTable.genre,
  developer: gamesTable.developer,
  publisher: gamesTable.publisher,
  coverUrl: gamesTable.coverUrl,
  firstPlayedYear: gamesTable.firstPlayedYear,
  hoursTenths: gamesTable.hoursTenths,
  achievementsUnlocked: gamesTable.achievementsUnlocked,
  achievementsTotal: gamesTable.achievementsTotal,
  metacritic: gamesTable.metacritic,
} as const satisfies Record<FillableField, unknown>;

export interface MergeInput {
  readonly winnerId: string;
  readonly loserId: string;
  /** Values from the loser to write onto the winner — only ever fields the winner is missing. */
  readonly fills: Readonly<Partial<Record<FillableField, unknown>>>;
  readonly platinum: boolean;
  /** The platform the surviving row should carry. A per-pair decision; see `duplicates.ts`. */
  readonly platform: GamePlatform;
  /**
   * A title to create inside the winner, or `null`. Set only for a flattened
   * collection row, where deleting the loser would otherwise remove a game
   * from the owner's count — see `MergePlan.createsMember`.
   */
  readonly createMemberTitle?: string | null;
  /** The platform for that new member — the loser's, since it is the loser's title being restored. */
  readonly createMemberPlatform?: GamePlatform;
}

/**
 * Merges one game into another and DELETES the loser.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONLY DESTRUCTIVE WRITE IN THIS APP THAT IS NOT AN EXPLICIT "REMOVE THIS
 * GAME". Four things happen, in one transaction, and THE ORDER IS FORCED FROM
 * BOTH ENDS:
 *
 *   1. any games filed under the LOSER are re-parented to the winner;
 *   2. any trophies stored against the loser are re-parented;
 *   3. the loser is deleted;
 *   4. the winner takes the fills, platinum and platform.
 *
 * Steps 1 and 2 must precede the delete, because `game_trophies.game_id` is
 * `ON DELETE CASCADE` and `games.collection_id` is `ON DELETE SET NULL` — do
 * the delete first and the trophies are gone and the members orphaned, silently
 * and unrecoverably. The detection layer already refuses to propose a merge
 * whose loser holds either, so in practice these two move nothing; they exist
 * because "the caller checked" is not something the database enforces, and the
 * cost of being wrong is deleted history.
 *
 * The winner's update must come AFTER the delete, and that one was found by
 * running it rather than by reading it. `games_owner_title_platform_idx` is
 * unique on (owner, lower(title), platform) — and the whole point of a merge is
 * that these two rows share a title. Writing the chosen platform onto the
 * winner while the loser still exists collides with the loser itself, and the
 * transaction dies on a `23505` naming an index that has nothing obviously to
 * do with the change being made. Deleting first leaves the name free.
 *
 * `updated_at` is bumped on the winner because a merge genuinely changes it —
 * and the library's default ordering reads a `coalesce` over play dates, so a
 * merged row must not silently jump position for a field nobody edited.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * @throws GameNotFoundError when either id is not the owner's.
 */
export async function mergeGames(ownerId: string, input: MergeInput): Promise<void> {
  if (input.winnerId === input.loserId) throw new GameNotFoundError();

  await getDb().transaction(async (tx) => {
    const present = await tx
      .select({ id: gamesTable.id })
      .from(gamesTable)
      .where(and(eq(gamesTable.ownerId, ownerId), inArray(gamesTable.id, [input.winnerId, input.loserId])));

    if (present.length !== 2) throw new GameNotFoundError();

    // Re-parent before deleting — see the doc comment.
    await tx
      .update(gamesTable)
      .set({ collectionId: input.winnerId, updatedAt: new Date() })
      .where(and(eq(gamesTable.ownerId, ownerId), eq(gamesTable.collectionId, input.loserId)));

    // `ON CONFLICT DO NOTHING` in spirit: the unique index is
    // (owner, game, source, external_id), so a trophy the winner already has
    // would collide. Dropping the loser's copy is correct — it is the same
    // trophy — and it is about to be deleted with the row anyway.
    await tx.execute(sql`
      update ${gameTrophies}
      set game_id = ${input.winnerId}
      where owner_id = ${ownerId}
        and game_id = ${input.loserId}
        and not exists (
          select 1 from ${gameTrophies} existing
          where existing.owner_id = ${ownerId}
            and existing.game_id = ${input.winnerId}
            and existing.source = ${gameTrophies}.source
            and existing.external_id = ${gameTrophies}.external_id
        )
    `);

    await tx.delete(gamesTable).where(and(eq(gamesTable.ownerId, ownerId), eq(gamesTable.id, input.loserId)));

    // LAST. The two rows share a title, so writing the chosen platform onto
    // the winner before the loser is gone violates the unique title+platform
    // index against the very row being merged away.
    const set: Record<string, unknown> = { updatedAt: new Date(), platform: input.platform };
    if (input.platinum) set.platinum = true;
    for (const [field, value] of Object.entries(input.fills)) {
      if (field in WRITABLE) set[field] = value;
    }

    await tx
      .update(gamesTable)
      .set(set)
      .where(and(eq(gamesTable.ownerId, ownerId), eq(gamesTable.id, input.winnerId)));

    // The game the flattened title named, restored as a real row inside the
    // collection. Created BARE — hours and price are the set's, and trophies
    // stay unset until a sync gives this title its own PSN list.
    if (input.createMemberTitle) {
      await tx.insert(gamesTable).values({
        ownerId,
        title: input.createMemberTitle,
        platform: input.createMemberPlatform ?? input.platform,
        status: 'backlog',
        collectionId: input.winnerId,
      });
    }
  });
}
