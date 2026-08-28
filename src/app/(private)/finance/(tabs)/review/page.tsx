import type { Metadata } from 'next';

import { ReviewQueue } from '@/features/finance/review/review-queue';
import { LEDGER_TRANSACTION_TYPES } from '@/features/finance/transactions/filters';
import { isUuid } from '@/lib/uuid';
import { requireOwner } from '@/server/auth/owner';
import { listCategories } from '@/server/db/finance/categories';
import {
  type ReviewStatus,
  type TransactionType,
  getReviewStatusCounts,
  listTransactionsForReview,
} from '@/server/db/finance/transactions';

export const metadata: Metadata = { title: 'Review — Burmy' };

type StatusFilter = ReviewStatus | 'all';

const STATUS_VALUES: readonly ReviewStatus[] = ['needs_review', 'auto', 'confirmed'];

function readParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function readStatus(value: string | undefined): StatusFilter {
  if (value === 'all') return 'all';
  if ((STATUS_VALUES as readonly string[]).includes(value ?? '')) return value as ReviewStatus;
  return 'needs_review';
}

/**
 * `readStatus` above has always checked its value against a known list. These
 * two never did — `type` was a bare `as TransactionType` cast and `category`
 * was passed through untouched — so `?type=garbage` reached an enum comparison
 * and `?category=garbage` reached a `uuid` one, and Postgres answers both by
 * RAISING (`22P02`). A hand-edited link 500'd instead of rendering an
 * unfiltered queue.
 *
 * Both drop an unrecognised value rather than 404ing, which is what every
 * other param on this page and in `parseLedgerFilters` already does. The
 * transaction-type list is shared with the ledger deliberately: two
 * independently-maintained copies of "the filterable types" is how one of them
 * silently goes stale.
 */
function readTransactionType(value: string | undefined): TransactionType | undefined {
  if (value && (LEDGER_TRANSACTION_TYPES as readonly string[]).includes(value)) {
    return value as TransactionType;
  }
  return undefined;
}

function readCategoryId(value: string | undefined): string | undefined {
  if (value === 'uncategorized') return 'uncategorized';
  return value && isUuid(value) ? value : undefined;
}

/**
 * Filters live in the URL (search params), not client state — a filtered view
 * is shareable and survives a refresh, and it keeps this a plain Server
 * Component: the query runs once, server-side, per filter change.
 */
export default async function ReviewPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const owner = await requireOwner();
  const params = await searchParams;

  const status = readStatus(readParam(params.status));
  const categoryId = readCategoryId(readParam(params.category));
  const transactionType = readTransactionType(readParam(params.type));

  // Built with `if` guards on a mutable local shape rather than merged
  // conditional spreads — `exactOptionalPropertyTypes` loses precision when
  // several `...(cond ? { key } : {})` spreads are combined into one object
  // literal, even though each is fine on its own (see CLAUDE.md).
  const reviewFilters: {
    status: StatusFilter;
    categoryId?: string;
    transactionType?: TransactionType;
  } = { status };
  if (categoryId) reviewFilters.categoryId = categoryId;
  if (transactionType) reviewFilters.transactionType = transactionType;

  const [transactions, categories, statusCounts] = await Promise.all([
    listTransactionsForReview(owner.userId, reviewFilters),
    listCategories(owner.userId),
    getReviewStatusCounts(owner.userId, reviewFilters),
  ]);

  return (
    <div className="space-y-8">
      {/* `ReviewQueue` renders this page's `PageHeader` itself, the same way
          `LibraryView` and `FinanceDashboard` do. It has to: the header's
          count is the number of rows STILL in the queue, which drops as the
          owner confirms them and therefore only exists as client state. The
          alternative — passing a callback up so a Server Component could
          re-render its own header — would be a round trip to move one
          integer.

          No description here or there. The previous one shipped the literal
          string "Anything M6 could not confidently resolve on its own," an
          internal milestone codename leaking into the UI, and prose on a
          screen the only user already understands is noise either way. */}
      <ReviewQueue
        transactions={transactions}
        categories={categories}
        filters={reviewFilters}
        statusCounts={statusCounts}
      />
    </div>
  );
}
