'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireOwner } from '@/server/auth/owner';
import { NotFoundError } from '@/server/db/finance/errors';
import { updateTransactionCategory, updateTransactionType } from '@/server/db/finance/transactions';
import { MANUAL_TRANSACTION_TYPES } from '@/server/finance/classify/manual';
import { type ActionResult, fail, ok } from './action-result';

/**
 * Server Actions for the Transactions ledger's inline edit. Every one begins
 * with `await requireOwner()` — see account-actions.ts for why that cannot
 * be delegated to a layout.
 *
 * These are thin, feature-local wrappers — like every other actions.ts in
 * this codebase — around the exact M7 mutation functions
 * (`updateTransactionCategory` / `updateTransactionType`), unmodified. That
 * is what carries over the counterpart unlink, `type_source =
 * 'manual_confirmation'`, and opt-in remember-merchant semantics with zero
 * new business logic. The only thing feature-local about this file is which
 * path it revalidates.
 */

const transactionIdSchema = z.string().uuid();
const categoryIdSchema = z.string().uuid();
const transactionTypeSchema = z.enum(MANUAL_TRANSACTION_TYPES);

function toResult(error: unknown): ActionResult {
  if (error instanceof NotFoundError) return fail(error.message);
  // A bug or a security refusal. Let it propagate rather than rendering it as
  // a field error.
  throw error;
}

export async function updateTransactionCategoryAction(
  transactionId: string,
  categoryId: string | null,
  rememberMerchant: boolean,
): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    await updateTransactionCategory(
      owner.userId,
      transactionIdSchema.parse(transactionId),
      categoryId === null ? null : categoryIdSchema.parse(categoryId),
      z.boolean().parse(rememberMerchant),
    );
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/finance/transactions');
  return ok();
}

export async function updateTransactionTypeAction(
  transactionId: string,
  transactionType: string,
): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    await updateTransactionType(
      owner.userId,
      transactionIdSchema.parse(transactionId),
      transactionTypeSchema.parse(transactionType),
    );
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/finance/transactions');
  return ok();
}
