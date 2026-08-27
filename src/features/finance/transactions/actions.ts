'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireOwner } from '@/server/auth/owner';
import { NotFoundError } from '@/server/db/finance/errors';
import {
  bulkUpdateCategory,
  previewMerchantRule,
  type MerchantRulePreview,
  updateTransactionCategory,
  updateTransactionMerchant,
  updateTransactionNote,
  updateTransactionType,
} from '@/server/db/finance/transactions';
import { MANUAL_TRANSACTION_TYPES } from '@/server/finance/classify/manual';
import { type ActionResult, fail, ok } from './action-result';

/**
 * Server Actions for inline transaction editing. Every one begins with
 * `await requireOwner()` — see account-actions.ts for why that cannot be
 * delegated to a layout.
 *
 * These are thin, feature-local wrappers — like every other actions.ts in
 * this codebase — around the exact M7 mutation functions
 * (`updateTransactionCategory` / `updateTransactionType`) plus their
 * round-2 siblings (`updateTransactionMerchant` / `updateTransactionNote`),
 * unmodified. That is what carries over the counterpart unlink, `type_source
 * = 'manual_confirmation'`, and opt-in remember-merchant semantics with zero
 * new business logic.
 *
 * Used from TWO surfaces — the Transactions ledger and the Monthly grid's
 * drill-down dialog — so every action revalidates both paths, not just its
 * own page.
 */

function revalidateBothSurfaces(): void {
  revalidatePath('/finance/transactions');
  revalidatePath('/finance/monthly');
}

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

  revalidateBothSurfaces();
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

  revalidateBothSurfaces();
  return ok();
}

/** Display-name correction only — see `updateTransactionMerchant`'s own doc comment. */
export async function updateTransactionMerchantAction(
  transactionId: string,
  normalizedMerchant: string,
): Promise<ActionResult> {
  const owner = await requireOwner();

  const trimmed = z.string().max(200).parse(normalizedMerchant).trim();

  try {
    await updateTransactionMerchant(owner.userId, transactionIdSchema.parse(transactionId), trimmed === '' ? null : trimmed);
  } catch (error) {
    return toResult(error);
  }

  revalidateBothSurfaces();
  return ok();
}

export async function updateTransactionNoteAction(transactionId: string, note: string): Promise<ActionResult> {
  const owner = await requireOwner();

  const trimmed = z.string().max(2000).parse(note).trim();

  try {
    await updateTransactionNote(owner.userId, transactionIdSchema.parse(transactionId), trimmed === '' ? null : trimmed);
  } catch (error) {
    return toResult(error);
  }

  revalidateBothSurfaces();
  return ok();
}

/**
 * What a "…and every other transaction from this merchant" rule would change,
 * before it changes anything.
 *
 * Read-only. The apply step is a SEPARATE action taking explicit ids, so the
 * owner can only ever commit to a set they were shown — nothing is inferred
 * between preview and write, and a merchant whose transactions changed in
 * between simply is not in the id list.
 */
export async function previewMerchantRuleAction(
  transactionId: string,
  categoryId: string,
  /** What the subject was categorized as a moment ago — see `previewMerchantRule` on why this decides what is pre-ticked. */
  fromCategoryId: string | null,
): Promise<
  | { readonly ok: true; readonly preview: MerchantRulePreview | null }
  | { readonly ok: false; readonly error: string }
> {
  const owner = await requireOwner();

  try {
    const preview = await previewMerchantRule(
      owner.userId,
      transactionIdSchema.parse(transactionId),
      categoryIdSchema.parse(categoryId),
      fromCategoryId === null ? null : categoryIdSchema.parse(fromCategoryId),
    );
    return { ok: true, preview };
  } catch (error) {
    const result = toResult(error);
    return { ok: false, error: result.ok ? 'Could not read this merchant.' : result.error };
  }
}

/**
 * Applies the rule to an EXPLICIT list of transaction ids, then remembers the
 * merchant so future imports land in the same place.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS REWRITES HISTORY, WHICH IS THE POINT AND ALSO THE RISK.
 *
 * Re-filing past transactions changes every monthly total those rows appear in.
 * That is exactly what the owner asked for — a fifth of their spending sat in
 * "Other" because a categorization decision could only ever apply forward — but
 * it means the write must never be broader than what was previewed. Hence ids,
 * not a merchant key: the server re-derives nothing.
 *
 * `bulkUpdateCategory` is reused rather than reimplemented; it already sets
 * `categorization_source = 'manual'` and `review_status = 'confirmed'` together,
 * which is the pairing CLAUDE.md records as easy to get wrong (a write that
 * "only touches its own fields" stranding a row whose review status was
 * computed under an assumption it just falsified).
 * ─────────────────────────────────────────────────────────────────────────────
 */
export async function applyMerchantRuleAction(
  transactionIds: readonly string[],
  categoryId: string,
): Promise<{ readonly ok: true; readonly updatedCount: number } | { readonly ok: false; readonly error: string }> {
  const owner = await requireOwner();

  try {
    const ids = z.array(transactionIdSchema).max(1000).parse(transactionIds);
    const updatedCount = await bulkUpdateCategory(owner.userId, ids, categoryIdSchema.parse(categoryId), true);
    revalidateBothSurfaces();
    return { ok: true, updatedCount };
  } catch (error) {
    const result = toResult(error);
    return { ok: false, error: result.ok ? 'Could not apply that rule.' : result.error };
  }
}
