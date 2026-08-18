'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireOwner } from '@/server/auth/owner';
import {
  ACCOUNT_TYPES,
  createAccount,
  setAccountActive,
  updateAccount,
} from '@/server/db/finance/accounts';
import { DuplicateNameError, NotFoundError } from '@/server/db/finance/errors';
import {
  InvalidLastFourError,
  InvalidNameError,
  assertValidName,
  parseLastFour,
} from '@/server/finance/taxonomy';
import { type ActionResult, fail, ok } from './action-result';

/**
 * Server Actions for accounts.
 *
 * Every one begins with `await requireOwner()`. Not because a layout forgot to —
 * because a Server Action is a POST to whatever route it happens to be used from,
 * so the parent layout's guard does not run for it. This is the rule the M2
 * enumeration test enforces by walking the filesystem.
 *
 * Input is validated with Zod even though the parameters are typed: types are
 * erased at runtime and these are public HTTP endpoints.
 */

const accountSchema = z.object({
  name: z.string(),
  type: z.enum(ACCOUNT_TYPES),
  institution: z.string(),
  lastFour: z.string(),
});

const idSchema = z.string().uuid();

/** Turn the domain's expected failures into field errors. */
function toResult(error: unknown): ActionResult {
  if (error instanceof InvalidNameError) return fail(error.message, 'name');
  if (error instanceof InvalidLastFourError) return fail(error.message, 'lastFour');
  if (error instanceof DuplicateNameError) return fail(error.message, 'name');
  if (error instanceof NotFoundError) return fail(error.message);
  // Anything else is a bug or a security refusal. Let it propagate.
  throw error;
}

function parse(formData: FormData): {
  name: string;
  type: (typeof ACCOUNT_TYPES)[number];
  institution: string | null;
  lastFour: string | null;
} {
  const raw = accountSchema.parse({
    name: formData.get('name') ?? '',
    type: formData.get('type') ?? '',
    institution: formData.get('institution') ?? '',
    lastFour: formData.get('lastFour') ?? '',
  });

  const institution = raw.institution.trim();

  return {
    name: assertValidName(raw.name),
    type: raw.type,
    institution: institution === '' ? null : institution,
    // Rejects anything that is not exactly 4 digits — never truncates a pasted
    // full account number. See taxonomy.ts.
    lastFour: parseLastFour(raw.lastFour),
  };
}

export async function createAccountAction(formData: FormData): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    await createAccount(owner.userId, parse(formData));
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/settings/finance/accounts');
  return ok();
}

export async function updateAccountAction(id: string, formData: FormData): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    await updateAccount(owner.userId, idSchema.parse(id), parse(formData));
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/settings/finance/accounts');
  return ok();
}

/**
 * Deactivate or reactivate. There is no delete action, and that is deliberate —
 * `finance_transactions.account_id` is `ON DELETE RESTRICT`, and an account with
 * no history today may have history next month. See accounts.ts.
 */
export async function setAccountActiveAction(id: string, isActive: boolean): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    await setAccountActive(owner.userId, idSchema.parse(id), z.boolean().parse(isActive));
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/settings/finance/accounts');
  return ok();
}
