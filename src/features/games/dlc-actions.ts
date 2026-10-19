'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireOwner } from '@/server/auth/owner';
import { type DlcInput, createDlc, deleteDlc, updateDlc } from '@/server/db/games/dlc';
import {
  DlcOnCollectionMemberError,
  DuplicateDlcError,
  GameNotFoundError,
} from '@/server/db/games/errors';
import { fromHoursInput } from '@/server/games/hours';
import { type ActionResult, fail, ok } from './action-result';

/**
 * Server Actions for a game's DLC rows (`src/server/db/games/dlc.ts`).
 *
 * Every one begins with `await requireOwner()` — see `game-actions.ts` for why
 * that is the boundary and the proxy is only defense-in-depth. Shapes mirror
 * `updateGameFieldAction`: one scalar per call for the panel's inline cells,
 * an empty commit clears a nullable figure, and `name`/`year` can never be
 * blanked because a DLC without them is not a DLC.
 */

const idSchema = z.string().uuid();

const DLC_FIELD_SCHEMAS = {
  name: z.string().trim().min(1, 'Name is required').max(300),
  year: z.coerce.number().int().min(1970).max(2100),
  achievementsUnlocked: z.coerce.number().int().min(0).max(10_000),
  achievementsTotal: z.coerce.number().int().min(0).max(10_000),
  priceDollars: z.coerce.number().min(0).max(10_000),
} as const;

export type DlcFieldKey =
  'name' | 'year' | 'hours' | 'priceDollars' | 'achievementsUnlocked' | 'achievementsTotal';

/**
 * Parsed through an OBJECT schema, not the bare field schemas: a bare
 * `z.string().parse('')` reports an issue with an EMPTY path, so `toResult`
 * could never point the failure at the field. Through the object, the issue
 * path is `['name']` / `['year']` and the form highlights the right box.
 */
const nameYearSchema = z.object({ name: DLC_FIELD_SCHEMAS.name, year: DLC_FIELD_SCHEMAS.year });

const HOURS_MESSAGE = 'Hours must be a number like 23 or 23.5';

function hoursError(): z.ZodError {
  return new z.ZodError([{ code: 'custom', path: ['hours'], message: HOURS_MESSAGE }]);
}

function toResult(error: unknown): ActionResult {
  if (error instanceof DuplicateDlcError) {
    return fail(`"${error.duplicateName}" is already recorded on this game.`, 'name');
  }
  if (error instanceof DlcOnCollectionMemberError) return fail(error.message);
  if (error instanceof GameNotFoundError) return fail(error.message);
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    const path = issue?.path[0];
    const field = path === 'name' || path === 'hours' || path === 'year' ? path : undefined;
    return fail(issue?.message ?? 'That input is not valid', field);
  }
  throw error;
}

/** Empty-string form fields become `undefined`, not `''`, before validation. */
function text(formData: FormData, key: string): string | undefined {
  const raw = formData.get(key);
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

type MutableDlcInput = { -readonly [K in keyof DlcInput]: DlcInput[K] };

function parseCreate(formData: FormData): DlcInput {
  const input: MutableDlcInput = nameYearSchema.parse({
    name: text(formData, 'name') ?? '',
    year: text(formData, 'year') ?? '',
  });
  const hours = text(formData, 'hours');
  if (hours !== undefined) {
    const tenths = fromHoursInput(hours);
    if (tenths === null) throw hoursError();
    input.hoursTenths = tenths;
  }
  const price = text(formData, 'priceDollars');
  // Dollars in the form, cents in the database — never a float in storage.
  if (price !== undefined)
    input.priceCents = Math.round(DLC_FIELD_SCHEMAS.priceDollars.parse(price) * 100);
  const unlocked = text(formData, 'achievementsUnlocked');
  if (unlocked !== undefined)
    input.achievementsUnlocked = DLC_FIELD_SCHEMAS.achievementsUnlocked.parse(unlocked);
  const total = text(formData, 'achievementsTotal');
  if (total !== undefined)
    input.achievementsTotal = DLC_FIELD_SCHEMAS.achievementsTotal.parse(total);
  return input;
}

export async function createGameDlcAction(
  gameId: string,
  formData: FormData,
): Promise<ActionResult> {
  const owner = await requireOwner();
  try {
    const id = idSchema.parse(gameId);
    const input = parseCreate(formData);
    await createDlc(owner.userId, id, input);
  } catch (error) {
    return toResult(error);
  }
  revalidatePath('/games', 'layout');
  return ok();
}

export async function updateGameDlcFieldAction(
  dlcId: string,
  field: DlcFieldKey,
  rawValue: string,
): Promise<ActionResult> {
  const owner = await requireOwner();
  const trimmed = rawValue.trim();
  const patch: Partial<MutableDlcInput> = {};
  try {
    const id = idSchema.parse(dlcId);
    switch (field) {
      case 'name':
        patch.name = nameYearSchema.shape.name.parse(trimmed);
        break;
      case 'year':
        if (trimmed === '') {
          throw new z.ZodError([{ code: 'custom', path: ['year'], message: 'Year is required' }]);
        }
        patch.year = DLC_FIELD_SCHEMAS.year.parse(trimmed);
        break;
      case 'hours': {
        if (trimmed === '') {
          patch.hoursTenths = null;
          break;
        }
        const tenths = fromHoursInput(trimmed);
        if (tenths === null) throw hoursError();
        patch.hoursTenths = tenths;
        break;
      }
      case 'priceDollars':
        patch.priceCents =
          trimmed === '' ? null : Math.round(DLC_FIELD_SCHEMAS.priceDollars.parse(trimmed) * 100);
        break;
      case 'achievementsUnlocked':
        patch.achievementsUnlocked =
          trimmed === '' ? null : DLC_FIELD_SCHEMAS.achievementsUnlocked.parse(trimmed);
        break;
      case 'achievementsTotal':
        patch.achievementsTotal =
          trimmed === '' ? null : DLC_FIELD_SCHEMAS.achievementsTotal.parse(trimmed);
        break;
    }
    await updateDlc(owner.userId, id, patch);
  } catch (error) {
    return toResult(error);
  }
  revalidatePath('/games', 'layout');
  return ok();
}

export async function deleteGameDlcAction(dlcId: string): Promise<ActionResult> {
  const owner = await requireOwner();
  try {
    await deleteDlc(owner.userId, idSchema.parse(dlcId));
  } catch (error) {
    return toResult(error);
  }
  revalidatePath('/games', 'layout');
  return ok();
}
