'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { type ActionResult, fail, ok } from '@/features/games/action-result';
import { requireOwner } from '@/server/auth/owner';
import { listDuplicateCandidates, mergeGames } from '@/server/db/games/duplicates';
import { GameNotFoundError, isUniqueViolation } from '@/server/db/games/errors';
import { FILLABLE_FIELDS, findDuplicates } from '@/server/games/duplicates';
import { GAME_PLATFORMS } from '@/server/games/taxonomy';

const idSchema = z.string().uuid();
const platformSchema = z.enum(GAME_PLATFORMS);

/**
 * `game-actions.ts` has its own richer mapper, but it cannot be shared: every
 * EXPORT from a `'use server'` module becomes a callable Server Action, so a
 * helper exported for reuse would be a new HTTP endpoint. Hence a local one,
 * narrowed to the two errors this action can actually raise.
 */
function toResult(error: unknown): ActionResult {
  if (error instanceof GameNotFoundError) return fail(error.message);
  if (error instanceof z.ZodError) return fail('That request was not valid.');
  // Drizzle WRAPS driver errors, so the SQLSTATE is on the `cause` chain and
  // never on `error.code` — see CLAUDE.md. `isUniqueViolation` walks it.
  if (isUniqueViolation(error)) {
    return fail('Those two rows collide on title and platform. Try the other platform for the surviving row.');
  }
  throw error;
}

/**
 * Merge one game into another.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PLAN IS RE-DERIVED SERVER-SIDE, NOT TAKEN FROM THE CLIENT.
 *
 * The screen sends only three things: which pair, and which platform the
 * survivor should carry. Everything else — who wins, what carries over,
 * whether the merge is allowed at all — is recomputed here from the current
 * database state.
 *
 * Two reasons, and the second is the one that matters. A client-supplied fills
 * object would be a client-supplied list of columns to write, which is an
 * arbitrary-write primitive wearing a merge's clothes. And a plan built when
 * the page rendered can be stale by the time it is clicked: a sync could have
 * linked the other copy, or a game could have been filed into the row about to
 * be deleted. Re-deriving means the merge either matches a proposal the server
 * itself would make right now, or it does not happen.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export async function mergeDuplicateAction(
  winnerId: string,
  loserId: string,
  platform: string,
): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    const winner = idSchema.parse(winnerId);
    const loser = idSchema.parse(loserId);
    const chosenPlatform = platformSchema.parse(platform);

    const { rows, holdsMembers, hasTrophies } = await listDuplicateCandidates(owner.userId);
    const { merges } = findDuplicates(rows, { holdsMembers, hasTrophies });

    const plan = merges.find((entry) => entry.winner.id === winner && entry.loser.id === loser);
    if (plan === undefined) {
      return {
        ok: false,
        error:
          'That merge is no longer being proposed — the library has changed since this page loaded. Reload and check the pair again.',
      };
    }

    // The chosen platform has to be one of the two rows' own. Anything else
    // would be this action inventing a value neither copy ever had.
    if (!plan.platforms.includes(chosenPlatform)) {
      return { ok: false, error: 'That platform does not belong to either copy.' };
    }

    // Rebuilt from the server's own plan rather than passed through, so the
    // set of writable columns is fixed by `FILLABLE_FIELDS` and not by input.
    const fills: Record<string, unknown> = {};
    for (const field of FILLABLE_FIELDS) {
      if (field in plan.fills) fills[field] = plan.fills[field];
    }

    await mergeGames(owner.userId, {
      winnerId: winner,
      loserId: loser,
      fills,
      platinum: plan.platinum,
      platform: chosenPlatform,
      // Taken from the server's own plan, never from the request — this
      // creates a row, and a client-supplied title would be a client-supplied
      // INSERT.
      createMemberTitle: plan.createsMember,
      createMemberPlatform: plan.loser.platform,
    });
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/games', 'layout');
  return ok();
}
