'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireOwner } from '@/server/auth/owner';
import {
  ANIME_FORMATS,
  ANIME_SEASONS,
  ANIME_SOURCES,
  ANIME_STATUSES,
} from '@/server/anime/taxonomy';
import { suggestSeriesTitle } from '@/server/anime/series';
import {
  type Anime,
  type AnimeInput,
  createAnime,
  deleteAnime,
  getAnime,
  updateAnime,
} from '@/server/db/anime/anime';
import { AnimeNotFoundError, AnimeSeriesNotFoundError, isUniqueViolation } from '@/server/db/anime/errors';
import { createSeries, deleteSeries, renameSeries, setSeriesForAnime } from '@/server/db/anime/series';
import { type ActionResult, fail, ok } from './action-result';

/**
 * Server Actions for the anime library.
 *
 * EVERY ONE BEGINS WITH `await requireOwner()`. Next.js handles Server
 * Functions as POSTs to the route where they are used, so `src/proxy.ts`'s
 * matcher is defense-in-depth and never the boundary — see
 * `src/server/auth/owner.ts`.
 *
 * Expected failures come back as an `ActionResult`; unexpected ones still
 * throw, so an auth refusal is never flattened into something that reads like
 * a typo.
 */

const idSchema = z.string().uuid();

/**
 * One field per commit, because that is how the page edits.
 *
 * `episodes`, `progress` and `repeatCount` are `smallint` columns, so the
 * ceilings here are not arbitrary politeness — they keep a typo from reaching
 * Postgres as an out-of-range error that surfaces as a 500 rather than a field
 * message. One Piece is past 1,100 episodes, so the episode ceiling has real
 * headroom over any show that exists.
 */
const FIELD_SCHEMAS = {
  titleRomaji: z.string().trim().min(1, 'Title is required').max(300),
  titleEnglish: z.string().trim().max(300),
  status: z.enum(ANIME_STATUSES),
  format: z.enum(ANIME_FORMATS),
  season: z.enum(ANIME_SEASONS),
  source: z.enum(ANIME_SOURCES),
  episodes: z.coerce.number().int().min(0).max(10_000),
  progress: z.coerce.number().int().min(0).max(10_000),
  repeatCount: z.coerce.number().int().min(0).max(500),
  durationMinutes: z.coerce.number().int().min(0).max(1000),
  seasonYear: z.coerce.number().int().min(1900).max(2100),
  studio: z.string().trim().max(300),
  genre: z.string().trim().max(300),
  notes: z.string().trim().max(4000),
  synopsis: z.string().trim().max(8000),
  coverUrl: z.string().url().max(2000),
  startedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  completedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
} as const;

export type AnimeFieldKey = keyof typeof FIELD_SCHEMAS;

/**
 * A MUTABLE local object, built with plain `if` statements, rather than a
 * merged set of conditional spreads.
 *
 * `exactOptionalPropertyTypes` loses precision when several
 * `...(cond ? { key } : {})` spreads are combined into one literal — verified
 * as a real inference gap during M7, not a typo — and this builds up to
 * eighteen optional fields. `AnimeInput`'s own fields are `readonly`, so the
 * local shape has to be a non-readonly mirror.
 */
type MutablePatch = {
  -readonly [K in keyof AnimeInput]?: AnimeInput[K];
};

/** The same shape for a CREATE, where `titleRomaji` is the one field that must be present. */
type MutableInput = MutablePatch & { titleRomaji: string };

function toResult(error: unknown): ActionResult {
  if (error instanceof AnimeNotFoundError) return fail('That show no longer exists.');
  if (error instanceof AnimeSeriesNotFoundError) return fail('That series no longer exists.');
  if (error instanceof z.ZodError) return fail(error.issues[0]?.message ?? 'That value is not valid.');
  if (isUniqueViolation(error)) return fail('A show with that AniList entry already exists.');
  throw error;
}

/**
 * Applies one field's new value.
 *
 * AN EMPTY COMMIT CLEARS AN OPTIONAL FIELD. `titleRomaji` and `status` cannot
 * be blanked this way and need no special case — their own schemas reject an
 * empty string on their own terms (`min(1)`, enum membership).
 *
 * `progress` is deliberately NOT clamped to `episodes`. AniList regularly
 * carries progress past a stale episode count while a show is still airing,
 * and refusing the owner's own number because a third-party total has not
 * caught up would be the app arguing with the person who watched it.
 * `watchPercent` clamps for DISPLAY instead.
 */
export async function updateAnimeFieldAction(
  id: string,
  field: AnimeFieldKey,
  rawValue: string,
): Promise<ActionResult> {
  const owner = await requireOwner();

  let animeId: string;
  try {
    animeId = idSchema.parse(id);
    await getAnime(owner.userId, animeId);
  } catch (error) {
    return toResult(error);
  }

  const trimmed = rawValue.trim();
  const patch: MutablePatch = {};

  try {
    // An EXHAUSTIVE switch, not `{ [field]: value }`. The computed key would
    // typecheck just as well and is exactly what makes an arbitrary column
    // name possible later; the switch makes it structurally impossible. Same
    // reasoning `fieldPatch` in `db/anime/sync.ts` spells out.
    switch (field) {
      case 'titleRomaji':
        patch.titleRomaji = FIELD_SCHEMAS.titleRomaji.parse(trimmed);
        break;
      case 'status':
        patch.status = FIELD_SCHEMAS.status.parse(trimmed);
        break;
      case 'titleEnglish':
        patch.titleEnglish = trimmed === '' ? null : FIELD_SCHEMAS.titleEnglish.parse(trimmed);
        break;
      case 'format':
        patch.format = trimmed === '' ? null : FIELD_SCHEMAS.format.parse(trimmed);
        break;
      case 'season':
        patch.season = trimmed === '' ? null : FIELD_SCHEMAS.season.parse(trimmed);
        break;
      case 'source':
        patch.source = trimmed === '' ? null : FIELD_SCHEMAS.source.parse(trimmed);
        break;
      case 'episodes':
        patch.episodes = trimmed === '' ? null : FIELD_SCHEMAS.episodes.parse(trimmed);
        break;
      case 'progress':
        // Not nullable in the schema — an empty commit means "back to zero",
        // which is a real answer, unlike "unknown".
        patch.progress = trimmed === '' ? 0 : FIELD_SCHEMAS.progress.parse(trimmed);
        break;
      case 'repeatCount':
        patch.repeatCount = trimmed === '' ? 0 : FIELD_SCHEMAS.repeatCount.parse(trimmed);
        break;
      case 'durationMinutes':
        patch.durationMinutes = trimmed === '' ? null : FIELD_SCHEMAS.durationMinutes.parse(trimmed);
        break;
      case 'seasonYear':
        patch.seasonYear = trimmed === '' ? null : FIELD_SCHEMAS.seasonYear.parse(trimmed);
        break;
      case 'studio':
        patch.studio = trimmed === '' ? null : FIELD_SCHEMAS.studio.parse(trimmed);
        break;
      case 'genre':
        patch.genre = trimmed === '' ? null : FIELD_SCHEMAS.genre.parse(trimmed);
        break;
      case 'notes':
        patch.notes = trimmed === '' ? null : FIELD_SCHEMAS.notes.parse(trimmed);
        break;
      case 'synopsis':
        patch.synopsis = trimmed === '' ? null : FIELD_SCHEMAS.synopsis.parse(trimmed);
        break;
      case 'coverUrl':
        patch.coverUrl = trimmed === '' ? null : FIELD_SCHEMAS.coverUrl.parse(trimmed);
        break;
      case 'startedAt':
        patch.startedAt = trimmed === '' ? null : FIELD_SCHEMAS.startedAt.parse(trimmed);
        break;
      case 'completedAt':
        patch.completedAt = trimmed === '' ? null : FIELD_SCHEMAS.completedAt.parse(trimmed);
        break;
      default: {
        const exhaustive: never = field;
        return fail(`Unknown field: ${String(exhaustive)}`);
      }
    }
  } catch (error) {
    return toResult(error);
  }

  try {
    await updateAnime(owner.userId, animeId, patch);
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/anime', 'layout');
  return ok();
}

const newAnimeSchema = z.object({
  titleRomaji: FIELD_SCHEMAS.titleRomaji,
  titleEnglish: z.string().trim().max(300).optional(),
  status: FIELD_SCHEMAS.status,
  format: z.enum(ANIME_FORMATS).optional(),
  episodes: z.coerce.number().int().min(0).max(10_000).optional(),
  progress: z.coerce.number().int().min(0).max(10_000).optional(),
  durationMinutes: z.coerce.number().int().min(0).max(1000).optional(),
  seasonYear: z.coerce.number().int().min(1900).max(2100).optional(),
  studio: z.string().trim().max(300).optional(),
  genre: z.string().trim().max(300).optional(),
});

/**
 * Adds a show by hand — the path the owner uses once the AniList migration is
 * done and they are tracking in Burmy directly.
 *
 * A hand-added row carries NO `anilistMediaId`, which is exactly right: it has
 * no AniList entry to be linked to. The sync leaves such a row completely
 * alone (`advanceAnimeSyncAction` skips rows with no stored id), so nothing a
 * later sync does can overwrite what was typed here.
 */
export async function createAnimeAction(formData: FormData): Promise<ActionResult> {
  const owner = await requireOwner();

  const raw = Object.fromEntries(
    [...formData.entries()].filter(([, value]) => typeof value === 'string' && value.trim() !== ''),
  );

  let parsed: z.infer<typeof newAnimeSchema>;
  try {
    parsed = newAnimeSchema.parse(raw);
  } catch (error) {
    return toResult(error);
  }

  const input: MutableInput = { titleRomaji: parsed.titleRomaji };
  if (parsed.titleEnglish !== undefined) input.titleEnglish = parsed.titleEnglish;
  if (parsed.status !== undefined) input.status = parsed.status;
  if (parsed.format !== undefined) input.format = parsed.format;
  if (parsed.episodes !== undefined) input.episodes = parsed.episodes;
  if (parsed.progress !== undefined) input.progress = parsed.progress;
  if (parsed.durationMinutes !== undefined) input.durationMinutes = parsed.durationMinutes;
  if (parsed.seasonYear !== undefined) input.seasonYear = parsed.seasonYear;
  if (parsed.studio !== undefined) input.studio = parsed.studio;
  if (parsed.genre !== undefined) input.genre = parsed.genre;

  try {
    await createAnime(owner.userId, input);
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/anime', 'layout');
  return ok();
}

/**
 * Removes a show from the library permanently.
 *
 * The one destructive write in this module. Nothing cascades outward that the
 * owner did not ask to lose: `anime_watch_log` rows for this show go with it
 * (`ON DELETE CASCADE`), which is correct — a log entry for a show that is not
 * in the library is an orphan, not history worth keeping.
 */
export async function deleteAnimeAction(id: string): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    await deleteAnime(owner.userId, idSchema.parse(id));
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/anime', 'layout');
  return ok();
}

// ─────────────────────────────────────────────────────────────────────────────
// Series — both ends of the same relationship
// ─────────────────────────────────────────────────────────────────────────────

/** The show page's "Part of" field: one show, one series (or none). */
export async function setAnimeSeriesAction(animeId: string, seriesId: string | null): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    const parsedAnimeId = idSchema.parse(animeId);
    const parsedSeriesId = seriesId === null || seriesId === '' ? null : idSchema.parse(seriesId);
    await setSeriesForAnime(owner.userId, [parsedAnimeId], parsedSeriesId);
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/anime', 'layout');
  return ok();
}

/** The series page's "Add seasons" panel: many shows, one series. The same write, from the other end. */
export async function addAnimeToSeriesAction(
  seriesId: string,
  animeIds: readonly string[],
): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    const parsedSeriesId = idSchema.parse(seriesId);
    const parsedIds = animeIds.map((id) => idSchema.parse(id));
    await setSeriesForAnime(owner.userId, parsedIds, parsedSeriesId);
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/anime', 'layout');
  return ok();
}

/**
 * Creates a series and files a show into it in one step.
 *
 * The title defaults to `suggestSeriesTitle(show's title)` — a SUGGESTION for
 * an editable field, never an identity key. `anime_series.anilist_parent_id`
 * is what makes a re-sync resolve the same series; deriving identity from a
 * heuristic title is the mistake `dedupe_key` vs `merchant_key` exists to
 * document.
 */
export async function createSeriesForAnimeAction(
  animeId: string,
  title?: string,
): Promise<ActionResult & { seriesId?: string }> {
  const owner = await requireOwner();

  try {
    const parsedAnimeId = idSchema.parse(animeId);
    const show: Anime = await getAnime(owner.userId, parsedAnimeId);
    const name = (title ?? '').trim() === '' ? suggestSeriesTitle(show.titleRomaji) : (title ?? '').trim();

    const series = await createSeries(owner.userId, { title: name });
    await setSeriesForAnime(owner.userId, [parsedAnimeId], series.id);

    revalidatePath('/anime', 'layout');
    return { ...ok(), seriesId: series.id };
  } catch (error) {
    if (isUniqueViolation(error)) return fail('You already have a series with that name.');
    return toResult(error);
  }
}

export async function renameSeriesAction(seriesId: string, title: string): Promise<ActionResult> {
  const owner = await requireOwner();

  const name = title.trim();
  if (name === '') return fail('A series needs a name.');

  try {
    await renameSeries(owner.userId, idSchema.parse(seriesId), name);
  } catch (error) {
    if (isUniqueViolation(error)) return fail('You already have a series with that name.');
    return toResult(error);
  }

  revalidatePath('/anime', 'layout');
  return ok();
}

/**
 * Dissolves a series. THE SHOWS INSIDE SURVIVE — `anime.series_id` is
 * `ON DELETE SET NULL`, so every season comes back out as a standalone entry.
 * See `deleteSeries`.
 */
export async function deleteSeriesAction(seriesId: string): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    await deleteSeries(owner.userId, idSchema.parse(seriesId));
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/anime', 'layout');
  return ok();
}
