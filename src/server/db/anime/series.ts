/**
 * Owner-scoped data access for `anime_series`, and the two writes that move a
 * show in or out of one.
 *
 * `ownerId` is the first parameter of every function and goes into every
 * WHERE, including the delete — the same structural discipline the rest of
 * `db/anime`, `db/games` and `db/finance` hold.
 *
 * Read helpers for series LISTS live in `anime.ts` (`listSeries`) because
 * that is where the library reads them from; this module owns the writes and
 * the single-series read.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';

import { getDb } from '@/server/db';
import { anime as animeTable, animeSeries } from '@/server/db/schema';
import { AnimeSeriesNotFoundError } from './errors';
import type { AnimeSeriesRow } from './anime';

/** @throws AnimeSeriesNotFoundError for a missing series AND for one belonging to someone else. */
export async function getSeries(ownerId: string, id: string): Promise<AnimeSeriesRow> {
  const [row] = await getDb()
    .select({
      id: animeSeries.id,
      title: animeSeries.title,
      coverUrl: animeSeries.coverUrl,
      notes: animeSeries.notes,
      anilistParentId: animeSeries.anilistParentId,
    })
    .from(animeSeries)
    .where(and(eq(animeSeries.ownerId, ownerId), eq(animeSeries.id, id)))
    .limit(1);

  if (!row) throw new AnimeSeriesNotFoundError();
  return row;
}

export async function createSeries(
  ownerId: string,
  input: { readonly title: string; readonly anilistParentId?: number | null },
): Promise<AnimeSeriesRow> {
  const [row] = await getDb()
    .insert(animeSeries)
    .values({
      ownerId,
      title: input.title,
      ...(input.anilistParentId === undefined ? {} : { anilistParentId: input.anilistParentId }),
    })
    .returning({
      id: animeSeries.id,
      title: animeSeries.title,
      coverUrl: animeSeries.coverUrl,
      notes: animeSeries.notes,
      anilistParentId: animeSeries.anilistParentId,
    });

  if (!row) throw new AnimeSeriesNotFoundError();
  return row;
}

/** The fields a series owns and the owner may edit. `anilist_parent_id` is identity and is not among them. */
export type EditableSeriesField = 'title' | 'coverUrl' | 'notes';

/**
 * Writes one field.
 *
 * An EXHAUSTIVE SWITCH rather than a computed key, the same rule
 * `updateAnimeFieldAction` and `fieldPatch` both follow: `{ [field]: value }`
 * would typecheck just as well and is exactly what makes an arbitrary column
 * name possible later.
 *
 * `title` is the one field that cannot be nulled — a series must always have a
 * name — which the action above enforces before this is reached.
 */
export async function updateSeriesField(
  ownerId: string,
  id: string,
  field: EditableSeriesField,
  value: string | null,
): Promise<void> {
  const patch: Partial<typeof animeSeries.$inferInsert> = {};
  switch (field) {
    case 'title':
      if (value === null) throw new AnimeSeriesNotFoundError();
      patch.title = value;
      break;
    case 'coverUrl':
      patch.coverUrl = value;
      break;
    case 'notes':
      patch.notes = value;
      break;
    default: {
      const exhaustive: never = field;
      throw new Error(`Refusing to write an unknown series field: ${String(exhaustive)}`);
    }
  }

  const result = await getDb()
    .update(animeSeries)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(animeSeries.ownerId, ownerId), eq(animeSeries.id, id)))
    .returning({ id: animeSeries.id });

  if (result.length === 0) throw new AnimeSeriesNotFoundError();
}

/**
 * Deletes a series. Its members SURVIVE.
 *
 * `anime.series_id` is `ON DELETE SET NULL`, so every season inside comes back
 * out as a standalone show — the same reasoning `games.collection_id` uses.
 * Dissolving a franchise must never be a way to lose the shows in it, and
 * there is no undo.
 */
export async function deleteSeries(ownerId: string, id: string): Promise<void> {
  const result = await getDb()
    .delete(animeSeries)
    .where(and(eq(animeSeries.ownerId, ownerId), eq(animeSeries.id, id)))
    .returning({ id: animeSeries.id });

  if (result.length === 0) throw new AnimeSeriesNotFoundError();
}

/**
 * Files a set of shows under a series, or removes them from one when
 * `seriesId` is `null`. Returns how many rows actually MOVED.
 *
 * `is distinct from` rather than `<>` so a row already filed where it is being
 * asked to go is not counted as a move and does not get a pointless
 * `updated_at` bump — the library's default ordering reads a coalesce over
 * watch dates, and a no-op write should not disturb anything. Null-safe by
 * construction, which plain `<>` is not: `series_id <> null` is never true, so
 * "remove these from their series" would report zero every time.
 *
 * The same helper serves both ends of the picker — the show page's "Part of"
 * field passes one id, the series page's "Add seasons" panel passes several.
 */
export async function setSeriesForAnime(
  ownerId: string,
  animeIds: readonly string[],
  seriesId: string | null,
): Promise<number> {
  if (animeIds.length === 0) return 0;

  const result = await getDb()
    .update(animeTable)
    .set({ seriesId, updatedAt: new Date() })
    .where(
      and(
        eq(animeTable.ownerId, ownerId),
        inArray(animeTable.id, [...animeIds]),
        sql`${animeTable.seriesId} is distinct from ${seriesId}`,
      ),
    )
    .returning({ id: animeTable.id });

  return result.length;
}
