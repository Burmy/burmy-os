'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireOwner } from '@/server/auth/owner';
import { DuplicateWishlistGameError } from '@/server/db/games/errors';
import {
  createWishlistGame,
  listWantedReleaseDates,
  updateWantedReleaseDate,
} from '@/server/db/games/games';
import type { UpcomingPlatform } from '@/server/games/upcoming';
import type { GamePlatform } from '@/server/games/taxonomy';
import { type ActionResult, fail, ok } from '../action-result';

/**
 * Server Actions for the "Upcoming games" tab and its wishlist.
 *
 * Every one begins with `await requireOwner()`, same as `game-actions.ts` —
 * Next.js handles Server Functions as POSTs to the route where they are
 * used, so proxy coverage is defense-in-depth and never the boundary.
 */

const wishlistInputSchema = z.object({
  igdbId: z.number().int().positive(),
  title: z.string().trim().min(1).max(300),
  coverUrl: z.string().url().max(2000).nullable(),
  releaseDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'releaseDate must be YYYY-MM-DD')
    .nullable(),
  releasePrecision: z.enum(['day', 'month']).nullable(),
  platforms: z.array(z.enum(['ps5', 'pc'])),
});

export interface WishlistAddInput {
  readonly igdbId: number;
  readonly title: string;
  readonly coverUrl: string | null;
  readonly releaseDate: string | null;
  readonly releasePrecision: 'day' | 'month' | null;
  readonly platforms: readonly UpcomingPlatform[];
}

/**
 * Adds one IGDB "Upcoming games" candidate to the wishlist: a `wanted`
 * `games` row stamped with `igdbId`/`coverUrl`/`releaseDate` straight from
 * IGDB's own data. Platform defaults to `ps5` when the candidate lists PS5,
 * else `steam` (IGDB's own `pc` id maps onto the owner's real "Steam / PC"
 * platform — see `PLATFORM_LABELS`); the owner can change it later from the
 * editor, same as any other field on a manually-added game.
 *
 * A duplicate `igdbId` — the owner already wishlisted (or since owns) this
 * exact game — comes back as a clean field-free error, not a 500:
 * `createWishlistGame` walks the driver error's `cause` chain via
 * `isUniqueViolation()` rather than trusting `error.code`, which Drizzle
 * does not preserve at the top level.
 */
export async function addToWishlistAction(input: WishlistAddInput): Promise<ActionResult> {
  const owner = await requireOwner();

  const parsed = wishlistInputSchema.safeParse(input);
  if (!parsed.success) return fail('That game could not be added to your wishlist.');

  const platform: GamePlatform = parsed.data.platforms.includes('ps5') ? 'ps5' : 'steam';

  try {
    await createWishlistGame(owner.userId, {
      igdbId: parsed.data.igdbId,
      title: parsed.data.title,
      coverUrl: parsed.data.coverUrl,
      releaseDate: parsed.data.releaseDate,
      releasePrecision: parsed.data.releasePrecision,
      platform,
    });
  } catch (error) {
    if (error instanceof DuplicateWishlistGameError) return fail(error.message);
    throw error;
  }

  revalidatePath('/games', 'layout');
  return ok();
}

/** One game's fresh reading, as `UpcomingView` already has it from the feed on screen. */
export interface ReleaseDateReading {
  readonly igdbId: number;
  readonly releaseDate: string | null;
  readonly releasePrecision: 'day' | 'month' | null;
}

/**
 * Corrects stored wishlist release dates against the feed the Upcoming page
 * has already fetched and rendered.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, AND WHY IT COSTS NOTHING.
 *
 * Wishlist rows are stamped with IGDB's date at the moment they are added, and
 * then never revisited. Two things go wrong with that. Every row added before
 * the query started requesting `release_dates.d` holds a `-01` PLACEHOLDER day
 * (see `RawReleaseDate.day`), so those games can never count down; and a game
 * that slips from November to March keeps advertising November forever.
 *
 * The Upcoming page already fetches twelve months of IGDB data containing
 * exactly these games, purely to render the grid. Reconciling against readings
 * the client already holds therefore adds no network call, no API quota, and no
 * new failure mode — it is bookkeeping on data that was on screen anyway.
 *
 * SAFETY. Only `wanted` rows with an `igdb_id` are eligible, enforced in the
 * UPDATE's own WHERE clause and not merely at the call site
 * (`updateWantedReleaseDate`), so a game the owner has since moved to another
 * status is untouchable — and so is a hand-added `wanted` row, which has no
 * `igdb_id` to match on. A hand-typed date on an IGDB-sourced row CAN be
 * overwritten by the feed's reading; that is the one caveat of reconciling. A reading with no date is SKIPPED rather than written as
 * null: `fetchUpcomingGames()` returns `[]` for a missing credential and for a
 * failed request alike (see `igdbConfigured()`), so "no date" can mean "IGDB
 * did not answer," and treating that as truth would erase every stored date.
 * The caller passes only games it actually rendered, which is the same
 * protection from the other side.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export async function reconcileWishlistReleaseDatesAction(
  readings: readonly ReleaseDateReading[],
): Promise<ActionResult> {
  const owner = await requireOwner();
  if (readings.length === 0) return ok();

  const byIgdbId = new Map(readings.map((reading) => [reading.igdbId, reading]));
  const stored = await listWantedReleaseDates(owner.userId);

  let changed = 0;
  for (const row of stored) {
    const reading = byIgdbId.get(row.igdbId);
    if (reading === undefined) continue;
    if (reading.releaseDate === null || reading.releasePrecision === null) continue;
    if (
      reading.releaseDate === row.releaseDate &&
      reading.releasePrecision === row.releasePrecision
    )
      continue;

    await updateWantedReleaseDate(
      owner.userId,
      row.igdbId,
      reading.releaseDate,
      reading.releasePrecision,
    );
    changed += 1;
  }

  // Only when something actually moved — an unconditional revalidate would
  // re-render the whole Games layout on every visit to Upcoming for nothing.
  if (changed > 0) revalidatePath('/games', 'layout');
  return ok();
}
