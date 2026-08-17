/**
 * Owner-scoped data access for M7's review queue: reading committed
 * transactions that need attention, and the three corrections an owner can
 * make to one.
 *
 * Same rule as every other file here: `ownerId` first, in every `WHERE`.
 */

import { alias } from 'drizzle-orm/pg-core';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { getDb } from '@/server/db';
import { financeAccounts, financeMerchantMemory, financeTransactions } from '@/server/db/schema';
import { reviewStatusForCorrection } from '@/server/finance/classify/manual';
import { defaultTransactionType, reviewStatusFor } from '@/server/finance/import/staging';
import { merchantKeyFrom } from '@/server/finance/merchant';
import { fromDb } from '@/server/finance/money';
import { NotFoundError } from './errors';

export type TransactionType = (typeof financeTransactions.$inferSelect)['transactionType'];
export type ReviewStatus = (typeof financeTransactions.$inferSelect)['reviewStatus'];

const counterpartTxn = alias(financeTransactions, 'counterpart_txn');
const counterpartAccount = alias(financeAccounts, 'counterpart_account');

// ─────────────────────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────────────────────

export interface ReviewFilters {
  /** Defaults to `'needs_review'`. `'all'` removes the status filter entirely. */
  readonly status?: ReviewStatus | 'all';
  readonly accountId?: string;
  /** `'uncategorized'` filters to `category_id IS NULL`, not a real category id. */
  readonly categoryId?: string | 'uncategorized';
  readonly transactionType?: TransactionType;
}

export interface ReviewTransaction {
  readonly id: string;
  readonly transactionDate: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly normalizedMerchant: string | null;
  readonly originalDescription: string;
  readonly amountCents: number;
  readonly categoryId: string | null;
  readonly transactionType: TransactionType;
  readonly typeSource: string;
  readonly reviewStatus: ReviewStatus;
  /** For the "linked to X — changing the type unlinks both" note. Null unless a counterpart-match is still live. */
  readonly counterpartAccountName: string | null;
}

const REVIEW_ROW_LIMIT = 500;

/**
 * Capped at `REVIEW_ROW_LIMIT`, not paginated. M6's whole premise is that this
 * list stays short — a real pagination UI is not worth building until that
 * premise is proven wrong.
 */
export async function listTransactionsForReview(
  ownerId: string,
  filters: ReviewFilters = {},
): Promise<ReviewTransaction[]> {
  const conditions = [eq(financeTransactions.ownerId, ownerId)];

  const status = filters.status ?? 'needs_review';
  if (status !== 'all') conditions.push(eq(financeTransactions.reviewStatus, status));
  if (filters.accountId) conditions.push(eq(financeTransactions.accountId, filters.accountId));
  if (filters.categoryId === 'uncategorized') conditions.push(isNull(financeTransactions.categoryId));
  else if (filters.categoryId) conditions.push(eq(financeTransactions.categoryId, filters.categoryId));
  if (filters.transactionType) conditions.push(eq(financeTransactions.transactionType, filters.transactionType));

  const rows = await getDb()
    .select({
      id: financeTransactions.id,
      transactionDate: financeTransactions.transactionDate,
      accountId: financeTransactions.accountId,
      accountName: financeAccounts.name,
      normalizedMerchant: financeTransactions.normalizedMerchant,
      originalDescription: financeTransactions.originalDescription,
      amountCents: financeTransactions.amountCents,
      categoryId: financeTransactions.categoryId,
      transactionType: financeTransactions.transactionType,
      typeSource: financeTransactions.typeSource,
      reviewStatus: financeTransactions.reviewStatus,
      counterpartAccountName: counterpartAccount.name,
    })
    .from(financeTransactions)
    .innerJoin(financeAccounts, eq(financeAccounts.id, financeTransactions.accountId))
    .leftJoin(counterpartTxn, eq(counterpartTxn.id, financeTransactions.counterpartTransactionId))
    .leftJoin(counterpartAccount, eq(counterpartAccount.id, counterpartTxn.accountId))
    .where(and(...conditions))
    .orderBy(desc(financeTransactions.transactionDate), asc(financeTransactions.id))
    .limit(REVIEW_ROW_LIMIT);

  return rows;
}

/** The nav badge. A single `count(*)`, nothing else — see CLAUDE.md on keeping it that way. */
export async function getNeedsReviewCount(ownerId: string): Promise<number> {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(financeTransactions)
    .where(and(eq(financeTransactions.ownerId, ownerId), eq(financeTransactions.reviewStatus, 'needs_review')));

  return row?.count ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Corrections
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Category correction. `categoryId: null` un-categorizes, which — per
 * `reviewStatusForCorrection` — sends a non-exclusionary transaction back to
 * `needs_review` rather than leaving it `confirmed` with nothing to show for
 * it.
 *
 * `rememberMerchant` is OFF by default in the review queue's own UI (a
 * correction here is a plausible one-off exception, not necessarily a
 * standing rule — see FINANCE.md). When true, upserts
 * `finance_merchant_memory` exactly as `commitImport()` does at import time.
 */
export async function updateTransactionCategory(
  ownerId: string,
  transactionId: string,
  categoryId: string | null,
  rememberMerchant: boolean,
): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [txn] = await tx
      .select()
      .from(financeTransactions)
      .where(and(eq(financeTransactions.id, transactionId), eq(financeTransactions.ownerId, ownerId)))
      .limit(1);
    if (!txn) throw new NotFoundError('Transaction');

    await tx
      .update(financeTransactions)
      .set({
        categoryId,
        categorizationSource: categoryId ? ('manual' as const) : null,
        reviewStatus: reviewStatusForCorrection(categoryId, txn.transactionType),
        updatedAt: new Date(),
      })
      .where(and(eq(financeTransactions.id, transactionId), eq(financeTransactions.ownerId, ownerId)));

    if (rememberMerchant && categoryId && txn.normalizedMerchant) {
      const merchantKey = merchantKeyFrom(txn.normalizedMerchant);

      await tx
        .insert(financeMerchantMemory)
        .values({ ownerId, merchantKey, categoryId })
        .onConflictDoUpdate({
          target: [financeMerchantMemory.ownerId, financeMerchantMemory.merchantKey],
          set: {
            categoryId,
            confirmedCount: sql`${financeMerchantMemory.confirmedCount} + 1`,
            lastConfirmedAt: new Date(),
          },
        });
    }
  });
}

/**
 * Manual type correction — the "explicit review confirmation" path invariant
 * 5 asks for. Always sets `type_source = 'manual_confirmation'`, which is
 * what permanently exempts this transaction from M6's automatic
 * classification from this point on (M6's counterpart search filters on
 * `type_source = 'default'`, nothing else).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE COUNTERPART UNLINK — atomic, both sides, every time
 *
 * If this transaction currently has a counterpart (M6 linked it), changing
 * its type breaks the pair entirely rather than leaving one side pointing at
 * a partner that no longer agrees with it:
 *
 *   THIS transaction  -> the new type, 'manual_confirmation', counterpart CLEARED.
 *   THE OTHER leg      -> reverts to the plain M5 default (expense/income by
 *                         sign), 'default', counterpart CLEARED, review status
 *                         recomputed via `reviewStatusFor` (M6's rule, since
 *                         it is reverting to its pre-match state, not being
 *                         corrected itself).
 *
 * No confirmation modal — the caller shows the link before this runs (see
 * `ReviewTransaction.counterpartAccountName`) so it is not a surprise, but
 * unlinking is not optional once a type actually changes.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export async function updateTransactionType(
  ownerId: string,
  transactionId: string,
  transactionType: TransactionType,
): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [txn] = await tx
      .select()
      .from(financeTransactions)
      .where(and(eq(financeTransactions.id, transactionId), eq(financeTransactions.ownerId, ownerId)))
      .limit(1);
    if (!txn) throw new NotFoundError('Transaction');

    await tx
      .update(financeTransactions)
      .set({
        transactionType,
        typeSource: 'manual_confirmation',
        counterpartTransactionId: null,
        reviewStatus: reviewStatusForCorrection(txn.categoryId, transactionType),
        updatedAt: new Date(),
      })
      .where(and(eq(financeTransactions.id, transactionId), eq(financeTransactions.ownerId, ownerId)));

    if (!txn.counterpartTransactionId) return;

    const [counterpart] = await tx
      .select()
      .from(financeTransactions)
      .where(
        and(
          eq(financeTransactions.id, txn.counterpartTransactionId),
          eq(financeTransactions.ownerId, ownerId),
        ),
      )
      .limit(1);
    // Already gone or somehow not this owner's — nothing to unlink on the
    // other side, and this transaction's own link is already cleared above.
    if (!counterpart) return;

    await tx
      .update(financeTransactions)
      .set({
        transactionType: defaultTransactionType(fromDb(counterpart.amountCents)),
        typeSource: 'default',
        counterpartTransactionId: null,
        reviewStatus: reviewStatusFor(
          counterpart.categoryId,
          counterpart.categorizationSource as 'manual' | 'merchant_memory' | null,
        ),
        updatedAt: new Date(),
      })
      .where(and(eq(financeTransactions.id, counterpart.id), eq(financeTransactions.ownerId, ownerId)));
  });
}

/**
 * Bulk category assignment. Deliberately the only bulk action, and
 * deliberately writes nothing to merchant memory — several unrelated
 * merchants are the common case for a bulk selection, and a per-row "remember
 * this" decision would defeat the point of keeping this simple.
 */
export async function bulkUpdateCategory(
  ownerId: string,
  transactionIds: readonly string[],
  categoryId: string,
): Promise<number> {
  if (transactionIds.length === 0) return 0;

  const updated = await getDb()
    .update(financeTransactions)
    .set({
      categoryId,
      categorizationSource: 'manual',
      // categoryId is always non-null here, so reviewStatusForCorrection
      // would always say 'confirmed' regardless of type — stated directly
      // rather than routed through the function for a fixed input.
      reviewStatus: 'confirmed',
      updatedAt: new Date(),
    })
    .where(and(eq(financeTransactions.ownerId, ownerId), inArray(financeTransactions.id, transactionIds)))
    .returning({ id: financeTransactions.id });

  return updated.length;
}
