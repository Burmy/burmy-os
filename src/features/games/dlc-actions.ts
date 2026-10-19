'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireOwner } from '@/server/auth/owner';
import { type DlcInput, createDlc, deleteDlc, updateDlc } from '@/server/db/games/dlc';
import {
  DuplicateDlcError,
  GameNotFoundError,
} from '@/server/db/games/errors';
import { fromHoursInput } from '@/server/games/hours';
import { type ActionResult, fail, ok } from './action-result';

/**
 * Server Actions for a game's DLC rows (`src/server/db/games/dlc.ts`).
 *
 * Every one begins with `await requireOwner()` — see `game-actions.ts` for why
 * that is the boundary and the proxy is only defense-in-depth. A DLC is edited
 * as a WHOLE ROW from one small dialog (`panel/dlc-dialog.tsx`): create and
 * update take the same form, where `name` and `year` are required and a
 * figure left blank is `null` — "cleared", the same rule `game-actions.ts`'s
 * `parse()` applies on update.
 */

const idSchema = z.string().uuid();

const DLC_FIELD_SCHEMAS = {
  name: z.string().trim().min(1, 'Name is required').max(300),
  year: z.coerce.number().int().min(1970).max(2100),
  achievementsUnlocked: z.coerce.number().int().min(0).max(10_000),
  achievementsTotal: z.coerce.number().int().min(0).max(10_000),
  priceDollars: z.coerce.number().min(0).max(10_000),
} as const;

/**
 * Parsed through an OBJECT schema, not the bare field schemas: a bare
 * `z.string().parse('')` reports an issue with an EMPTY path, so `toResult`
 * could never point the failure at the field. Through the object, the issue
 * path is `['name']` / `['year']` and the form highlights the right box. A
 * blank year is caught on the string before coercion would turn it into `0`.
 */
const nameYearSchema = z.object({
  name: DLC_FIELD_SCHEMAS.name,
  year: z
    .string()
    .trim()
    .min(1, 'Year is required')
    .transform((value) => Number(value))
    .pipe(z.number().int().min(1970).max(2100)),
});

const HOURS_MESSAGE = 'Hours must be a number like 23 or 23.5';

function hoursError(): z.ZodError {
  return new z.ZodError([{ code: 'custom', path: ['hours'], message: HOURS_MESSAGE }]);
}

function toResult(error: unknown): ActionResult {
  if (error instanceof DuplicateDlcError) {
    return fail(`"${error.duplicateName}" is already recorded on this game.`, 'name');
  }
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

/** The whole row from the dialog's form; a blank figure is `null`. */
function parseRow(formData: FormData): Required<DlcInput> {
  const { name, year } = nameYearSchema.parse({
    name: text(formData, 'name') ?? '',
    year: text(formData, 'year') ?? '',
  });
  const hours = text(formData, 'hours');
  let hoursTenths: number | null = null;
  if (hours !== undefined) {
    hoursTenths = fromHoursInput(hours);
    if (hoursTenths === null) throw hoursError();
  }
  const price = text(formData, 'priceDollars');
  const unlocked = text(formData, 'achievementsUnlocked');
  const total = text(formData, 'achievementsTotal');
  return {
    name,
    year,
    hoursTenths,
    // Dollars in the form, cents in the database — never a float in storage.
    priceCents:
      price === undefined ? null : Math.round(DLC_FIELD_SCHEMAS.priceDollars.parse(price) * 100),
    achievementsUnlocked:
      unlocked === undefined ? null : DLC_FIELD_SCHEMAS.achievementsUnlocked.parse(unlocked),
    achievementsTotal:
      total === undefined ? null : DLC_FIELD_SCHEMAS.achievementsTotal.parse(total),
  };
}

export async function createGameDlcAction(
  gameId: string,
  formData: FormData,
): Promise<ActionResult> {
  const owner = await requireOwner();
  try {
    const id = idSchema.parse(gameId);
    await createDlc(owner.userId, id, parseRow(formData));
  } catch (error) {
    return toResult(error);
  }
  revalidatePath('/games', 'layout');
  return ok();
}

export async function updateGameDlcAction(
  dlcId: string,
  formData: FormData,
): Promise<ActionResult> {
  const owner = await requireOwner();
  try {
    const id = idSchema.parse(dlcId);
    await updateDlc(owner.userId, id, parseRow(formData));
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
