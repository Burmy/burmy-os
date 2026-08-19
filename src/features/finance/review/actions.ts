'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireOwner } from '@/server/auth/owner';
import { NotFoundError } from '@/server/db/finance/errors';
import {
  bulkUpdateCategory,
  updateTransactionCategory,
  updateTransactionType,
} from '@/server/db/finance/transactions';
import { MANUAL_TRANSACTION_TYPES } from '@/server/finance/classify/manual';
import { type ActionResult, type BulkActionResult, fail, ok } from './action-result';

/**
 * Server Actions for the review queue. Every one begins with
 * `await requireOwner()` — see account-actions.ts for why that cannot be
 * delegated to a layout.
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

  revalidatePath('/finance/review');
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

  revalidatePath('/finance/review');
  return ok();
}

export async function bulkUpdateCategoryAction(
  transactionIds: readonly string[],
  categoryId: string,
  rememberMerchant = false,
): Promise<BulkActionResult> {
  const owner = await requireOwner();

  try {
    const ids = z.array(transactionIdSchema).min(1).parse(transactionIds);
    const updatedCount = await bulkUpdateCategory(
      owner.userId,
      ids,
      categoryIdSchema.parse(categoryId),
      z.boolean().parse(rememberMerchant),
    );
    revalidatePath('/finance/review');
    return { ok: true, updatedCount };
  } catch (error) {
    if (error instanceof NotFoundError) return { ok: false, error: error.message };
    throw error;
  }
}
