'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireOwner } from '@/server/auth/owner';
import { DuplicateWishlistGameError } from '@/server/db/games/errors';
import { createWishlistGame, promoteReleasedWantedGames } from '@/server/db/games/games';
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
  platforms: z.array(z.enum(['ps5', 'pc'])),
});

export interface WishlistAddInput {
  readonly igdbId: number;
  readonly title: string;
  readonly coverUrl: string | null;
  readonly releaseDate: string | null;
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
      platform,
    });
  } catch (error) {
    if (error instanceof DuplicateWishlistGameError) return fail(error.message);
    throw error;
  }

  revalidatePath('/games', 'layout');
  return ok();
}

/**
 * `wanted` -> `backlog` for every one of the owner's wishlist rows whose
 * `release_date` has passed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EDITS OWNER DATA WITHOUT ASKING — DELIBERATE, NOT AN OVERSIGHT.
 *
 * Fired once by `UpcomingView` on mount, and only when the server-computed
 * overdue count it was handed (`countOverdueWantedGames`, read by the
 * Upcoming page) is non-zero — see that component's own doc comment. The
 * flip cannot happen during the Server Component's own render: Next forbids
 * mutating data there, and doing so would fire unpredictably depending on
 * render timing rather than once, deliberately, on the client. The owner
 * decided during design review that a released wishlist entry should just
 * quietly become a backlog entry with no confirmation prompt — do not "fix"
 * this into one. Idempotent: a second call touches zero rows once the first
 * has already run (`promoteReleasedWantedGames`'s own contract).
 * ─────────────────────────────────────────────────────────────────────────────
 */
export async function promoteReleasedWantedGamesAction(): Promise<ActionResult> {
  const owner = await requireOwner();
  await promoteReleasedWantedGames(owner.userId);
  revalidatePath('/games', 'layout');
  return ok();
}
