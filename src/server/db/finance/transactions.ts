/**
 * Owner-scoped data access for M7's review queue: reading committed
 * transactions that need attention, and the three corrections an owner can
 * make to one.
 *
 * Same rule as every other file here: `ownerId` first, in every `WHERE`.
 */

import { alias } from 'drizzle-orm/pg-core';
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { cache } from 'react';

import { getDb } from '@/server/db';
import { financeAccounts, financeCategories, financeMerchantMemory, financeTransactions } from '@/server/db/schema';
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
  /** `'uncategorized'` filters to `category_id IS NULL`, not a real category id. */
  readonly categoryId?: string | 'uncategorized';
  readonly transactionType?: TransactionType;
}

export interface ReviewTransaction {
  readonly id: string;
  readonly transactionDate: string;
  readonly accountId: string;
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
  if (filters.categoryId === 'uncategorized') conditions.push(isNull(financeTransactions.categoryId));
  else if (filters.categoryId) conditions.push(eq(financeTransactions.categoryId, filters.categoryId));
  if (filters.transactionType) conditions.push(eq(financeTransactions.transactionType, filters.transactionType));

  const rows = await getDb()
    .select({
      id: financeTransactions.id,
      transactionDate: financeTransactions.transactionDate,
      accountId: financeTransactions.accountId,
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
    .leftJoin(counterpartTxn, eq(counterpartTxn.id, financeTransactions.counterpartTransactionId))
    .leftJoin(counterpartAccount, eq(counterpartAccount.id, counterpartTxn.accountId))
    .where(and(...conditions))
    .orderBy(desc(financeTransactions.transactionDate), asc(financeTransactions.id))
    .limit(REVIEW_ROW_LIMIT);

  return rows;
}

/** The nav badge. A single `count(*)`, nothing else — see CLAUDE.md on keeping it that way. */
/**
 * Wrapped in React's `cache()`: the Finance tabs layout (for the Review
 * badge) and the Monthly page (for its own inline alert) both call this on
 * every navigation — dedupe to one query per render pass rather than two.
 */
export const getNeedsReviewCount = cache(async function getNeedsReviewCount(ownerId: string): Promise<number> {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(financeTransactions)
    .where(and(eq(financeTransactions.ownerId, ownerId), eq(financeTransactions.reviewStatus, 'needs_review')));

  return row?.count ?? 0;
});

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

    const counterpartTransactionType = defaultTransactionType(fromDb(counterpart.amountCents));
    await tx
      .update(financeTransactions)
      .set({
        transactionType: counterpartTransactionType,
        typeSource: 'default',
        counterpartTransactionId: null,
        reviewStatus: reviewStatusFor(
          counterpart.categoryId,
          counterpart.categorizationSource as 'manual' | 'merchant_memory' | null,
          counterpartTransactionType,
        ),
        updatedAt: new Date(),
      })
      .where(and(eq(financeTransactions.id, counterpart.id), eq(financeTransactions.ownerId, ownerId)));
  });
}

/**
 * Display-name correction, post-commit — the same edit `updateRowDecision()`
 * already allows pre-commit (`imports.ts`), now reachable on an already-
 * imported transaction too (round-2 UX pass). Never touches `dedupeKey`
 * (derived from `originalDescription`, not this) or merchant memory (keyed
 * on `merchantKey`, also derived from the raw description) — same
 * non-interaction the import-time version already established.
 */
export async function updateTransactionMerchant(
  ownerId: string,
  transactionId: string,
  normalizedMerchant: string | null,
): Promise<void> {
  const rows = await getDb()
    .update(financeTransactions)
    .set({ normalizedMerchant, updatedAt: new Date() })
    .where(and(eq(financeTransactions.id, transactionId), eq(financeTransactions.ownerId, ownerId)))
    .returning({ id: financeTransactions.id });

  if (!rows[0]) throw new NotFoundError('Transaction');
}

/** Free-text note, post-commit — same shape as `updateTransactionMerchant`. */
export async function updateTransactionNote(
  ownerId: string,
  transactionId: string,
  notes: string | null,
): Promise<void> {
  const rows = await getDb()
    .update(financeTransactions)
    .set({ notes, updatedAt: new Date() })
    .where(and(eq(financeTransactions.id, transactionId), eq(financeTransactions.ownerId, ownerId)))
    .returning({ id: financeTransactions.id });

  if (!rows[0]) throw new NotFoundError('Transaction');
}

/**
 * Bulk category assignment. Deliberately the only bulk action, and
 * deliberately writes nothing to merchant memory — several unrelated
 * merchants are the common case for a bulk selection, and a per-row "remember
 * this" decision would defeat the point of keeping this simple.
 */
/**
 * `rememberMerchant` upserts memory for every DISTINCT merchant among the
 * selected rows — several unrelated merchants in one selection is the common
 * case for a bulk action, unlike the single-row `updateTransactionCategory`,
 * so this dedupes rather than writing (and overwriting) once per row. Same
 * upsert shape `commitImport()` already uses (`imports.ts`), not a new one.
 */
export async function bulkUpdateCategory(
  ownerId: string,
  transactionIds: readonly string[],
  categoryId: string,
  rememberMerchant = false,
): Promise<number> {
  if (transactionIds.length === 0) return 0;

  return getDb().transaction(async (tx) => {
    const updated = await tx
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
      .returning({ id: financeTransactions.id, normalizedMerchant: financeTransactions.normalizedMerchant });

    if (rememberMerchant) {
      const merchantKeys = new Set(
        updated
          .map((row) => (row.normalizedMerchant ? merchantKeyFrom(row.normalizedMerchant) : null))
          .filter((key): key is string => key !== null),
      );

      for (const merchantKey of merchantKeys) {
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
    }

    return updated.length;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// M9 — the transactions ledger: listing, reconciliation summary, export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE condition-builder, reused unmodified by the paginated listing, the
 * reconciliation summary, and the CSV export — so the three cannot
 * structurally disagree about what "the current filter" means, the same
 * guarantee `gridBaseConditions()` gives M8's aggregate/drill-down pair.
 *
 * Deliberately NOT `gridBaseConditions()` itself: this is a full-ledger
 * browser, not the monthly report. It defaults to every review status and
 * every transaction type — including `needs_review`, `transfer` and
 * `credit_card_payment` — because hiding those is exactly what Monthly does,
 * and exactly what a ledger must not do by default.
 */
export interface LedgerFilters {
  readonly year: number;
  readonly month?: number;
  /** `'uncategorized'` filters to `category_id IS NULL`, not a real category id. */
  readonly categoryId?: string | 'uncategorized';
  readonly transactionType?: TransactionType;
  /** Defaults to `'all'` — unlike Review, this page is a browser, not a worklist. */
  readonly reviewStatus?: ReviewStatus | 'all';
  /** Matches against both `original_description` and `normalized_merchant`, case-insensitive. */
  readonly search?: string;
}

function ledgerConditions(ownerId: string, filters: LedgerFilters) {
  const conditions = [
    eq(financeTransactions.ownerId, ownerId),
    gte(financeTransactions.transactionDate, `${filters.year}-01-01`),
    lte(financeTransactions.transactionDate, `${filters.year}-12-31`),
  ];

  if (filters.month) {
    conditions.push(sql`extract(month from ${financeTransactions.transactionDate}) = ${filters.month}`);
  }
  if (filters.categoryId === 'uncategorized') conditions.push(isNull(financeTransactions.categoryId));
  else if (filters.categoryId) conditions.push(eq(financeTransactions.categoryId, filters.categoryId));
  if (filters.transactionType) conditions.push(eq(financeTransactions.transactionType, filters.transactionType));

  const reviewStatus = filters.reviewStatus ?? 'all';
  if (reviewStatus !== 'all') conditions.push(eq(financeTransactions.reviewStatus, reviewStatus));

  const search = filters.search?.trim();
  if (search) {
    const term = `%${search}%`;
    const searchCondition = or(
      ilike(financeTransactions.originalDescription, term),
      ilike(financeTransactions.normalizedMerchant, term),
    );
    if (searchCondition) conditions.push(searchCondition);
  }

  return conditions;
}

export interface LedgerTransaction {
  readonly id: string;
  readonly transactionDate: string;
  readonly accountId: string;
  readonly normalizedMerchant: string | null;
  readonly originalDescription: string;
  readonly amountCents: number;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly transactionType: TransactionType;
  readonly reviewStatus: ReviewStatus;
  readonly categorizationSource: string | null;
  readonly typeSource: string;
  readonly notes: string | null;
}

const ledgerSelection = {
  id: financeTransactions.id,
  transactionDate: financeTransactions.transactionDate,
  accountId: financeTransactions.accountId,
  normalizedMerchant: financeTransactions.normalizedMerchant,
  originalDescription: financeTransactions.originalDescription,
  amountCents: financeTransactions.amountCents,
  categoryId: financeTransactions.categoryId,
  categoryName: financeCategories.name,
  transactionType: financeTransactions.transactionType,
  reviewStatus: financeTransactions.reviewStatus,
  categorizationSource: financeTransactions.categorizationSource,
  typeSource: financeTransactions.typeSource,
  notes: financeTransactions.notes,
} as const;

export const LEDGER_PAGE_SIZE = 100;

export interface LedgerPage {
  readonly rows: LedgerTransaction[];
  readonly totalCount: number;
}

/** `page` is 1-based. Plain `LIMIT`/`OFFSET` — simple and sufficient at personal-ledger scale; not a general pagination system. */
export async function listTransactionsLedger(
  ownerId: string,
  filters: LedgerFilters,
  page: number,
): Promise<LedgerPage> {
  const conditions = ledgerConditions(ownerId, filters);
  const offset = Math.max(0, page - 1) * LEDGER_PAGE_SIZE;

  const [rows, countRows] = await Promise.all([
    getDb()
      .select(ledgerSelection)
      .from(financeTransactions)
      .leftJoin(financeCategories, eq(financeCategories.id, financeTransactions.categoryId))
      .where(and(...conditions))
      .orderBy(desc(financeTransactions.transactionDate), desc(financeTransactions.id))
      .limit(LEDGER_PAGE_SIZE)
      .offset(offset),
    getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(financeTransactions)
      .where(and(...conditions)),
  ]);

  return { rows, totalCount: countRows[0]?.count ?? 0 };
}

export interface LedgerSummary {
  readonly totalCount: number;
  readonly needsReviewCount: number;
  /**
   * Per-status counts for the Status filter CHIPS, computed with every other
   * filter applied but WITHOUT the status filter itself — see
   * `statusFacetCounts` below for why that distinction is load-bearing.
   */
  readonly statusCounts: StatusFacetCounts;
}

export interface StatusFacetCounts {
  readonly all: number;
  readonly needs_review: number;
  readonly auto: number;
  readonly confirmed: number;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * A FACET COUNT MUST NOT INCLUDE ITS OWN FILTER.
 *
 * These feed the Status filter chips, which render their count inline
 * ("Needs review 12"). The count has to answer "how many rows would I see if
 * I picked this status," so it applies every OTHER active filter (year,
 * month, category, type, search) but deliberately drops the status condition.
 *
 * Reusing `ledgerConditions(ownerId, filters)` verbatim would be the obvious
 * shortcut and is wrong: that helper applies `filters.reviewStatus`, so the
 * moment the owner selects one status, every OTHER chip would count rows
 * that are simultaneously required to be two different statuses and read
 * `0`. The chips would look broken rather than merely inaccurate.
 *
 * Games' library already gets this right for the same reason — see
 * `library-view.tsx`, whose `counts` map is built from all `games` rather
 * than from the filtered set.
 * ─────────────────────────────────────────────────────────────────────────────
 */
async function statusFacetCounts(
  ownerId: string,
  conditionsWithoutStatus: ReturnType<typeof ledgerConditions>,
): Promise<StatusFacetCounts> {
  const [row] = await getDb()
    .select({
      all: sql<number>`count(*)::int`,
      needs_review: sql<number>`count(*) filter (where ${financeTransactions.reviewStatus} = 'needs_review')::int`,
      auto: sql<number>`count(*) filter (where ${financeTransactions.reviewStatus} = 'auto')::int`,
      confirmed: sql<number>`count(*) filter (where ${financeTransactions.reviewStatus} = 'confirmed')::int`,
    })
    .from(financeTransactions)
    .where(and(...conditionsWithoutStatus));

  return row ?? { all: 0, needs_review: 0, auto: 0, confirmed: 0 };
}

/**
 * One aggregate query over the SAME conditions the listing and the export
 * use. Deliberately no overall signed sum — mixing income, expense, refunds
 * and transfers into one number is not a meaningful total, and showing one
 * risked reading as an authoritative figure competing with Monthly's.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THERE IS NO FIGURE HERE FOR EXCLUDED (transfer / credit_card_payment) ROWS,
 * AND ADDING ONE IS HARDER THAN IT LOOKS.
 *
 * This used to report an `excludedCount` — a plain row count, deliberately
 * with no paired dollar amount — which the Transactions meta line rendered as
 * "N transfer/card payment transactions excluded from Monthly." The line was
 * removed as noise, so the field went with it rather than staying as dead SQL.
 *
 * The reasoning is kept because it is the expensive part, and a future feature
 * asking "how much was excluded?" will walk straight back into it: a
 * transfer/card-payment PAIR is TWO ROWS for ONE real movement of money. A
 * signed `SUM` cancels toward zero exactly when both legs are in scope, and
 * `SUM(ABS(...))` avoids the cancellation but then double-counts the pair — a
 * real $675 payment reads as $1,350 excluded, which is how this shipped once
 * before the owner caught it. Netting the pair back down to $675 means
 * MATCHING LEGS, which is real reconciliation logic this page deliberately
 * does not build. So: not a `SUM` vs `ABS` choice. If a dollar figure is ever
 * genuinely needed, it is pair-matching work — budget for it accordingly.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export async function getLedgerSummary(ownerId: string, filters: LedgerFilters): Promise<LedgerSummary> {
  const conditions = ledgerConditions(ownerId, filters);
  // `'all'` is exactly how `ledgerConditions` spells "no status condition",
  // so this reuses the same helper rather than forking its logic.
  const conditionsWithoutStatus = ledgerConditions(ownerId, { ...filters, reviewStatus: 'all' });

  const [[row], statusCounts] = await Promise.all([
    getDb()
      .select({
        totalCount: sql<number>`count(*)::int`,
        needsReviewCount: sql<number>`count(*) filter (where ${financeTransactions.reviewStatus} = 'needs_review')::int`,
      })
      .from(financeTransactions)
      .where(and(...conditions)),
    statusFacetCounts(ownerId, conditionsWithoutStatus),
  ]);

  return { ...(row ?? { totalCount: 0, needsReviewCount: 0 }), statusCounts };
}

/**
 * Review's own status facet counts. Review has no aggregate of its own —
 * only `listTransactionsForReview` — so this is the equivalent of
 * `getLedgerSummary`'s status counts for that page's narrower filter shape,
 * and it follows the identical "drop the status condition" rule.
 */
export async function getReviewStatusCounts(
  ownerId: string,
  filters: ReviewFilters,
): Promise<StatusFacetCounts> {
  const conditions: ReturnType<typeof ledgerConditions> = [eq(financeTransactions.ownerId, ownerId)];
  if (filters.categoryId === 'uncategorized') conditions.push(isNull(financeTransactions.categoryId));
  else if (filters.categoryId) conditions.push(eq(financeTransactions.categoryId, filters.categoryId));
  if (filters.transactionType) conditions.push(eq(financeTransactions.transactionType, filters.transactionType));

  return statusFacetCounts(ownerId, conditions);
}

/** One more than the export cap, so the caller can tell "exactly at the cap" from "over it" and fail visibly rather than silently truncate. */
export const LEDGER_EXPORT_ROW_LIMIT = 20_000;

export interface LedgerExportResult {
  readonly rows: LedgerTransaction[];
  readonly exceedsLimit: boolean;
}

/**
 * Unpaginated — the CSV export ignores on-screen pagination by design,
 * always reflecting the full current filter. Bounded at
 * `LEDGER_EXPORT_ROW_LIMIT` as a sanity cap; the caller must refuse to
 * export rather than silently return a truncated file when `exceedsLimit`
 * is true.
 */
export async function listTransactionsForExport(
  ownerId: string,
  filters: LedgerFilters,
): Promise<LedgerExportResult> {
  const conditions = ledgerConditions(ownerId, filters);

  const rows = await getDb()
    .select(ledgerSelection)
    .from(financeTransactions)
    .leftJoin(financeCategories, eq(financeCategories.id, financeTransactions.categoryId))
    .where(and(...conditions))
    .orderBy(desc(financeTransactions.transactionDate), desc(financeTransactions.id))
    .limit(LEDGER_EXPORT_ROW_LIMIT + 1);

  if (rows.length > LEDGER_EXPORT_ROW_LIMIT) {
    return { rows: rows.slice(0, LEDGER_EXPORT_ROW_LIMIT), exceedsLimit: true };
  }
  return { rows, exceedsLimit: false };
}
