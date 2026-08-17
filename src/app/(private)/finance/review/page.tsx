import type { Metadata } from 'next';

import { ReviewQueue } from '@/features/finance/review/review-queue';
import { requireOwner } from '@/server/auth/owner';
import { listAccounts } from '@/server/db/finance/accounts';
import { listCategories } from '@/server/db/finance/categories';
import {
  type ReviewStatus,
  type TransactionType,
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
  const accountId = readParam(params.account);
  const categoryParam = readParam(params.category);
  const categoryId = categoryParam === 'uncategorized' ? 'uncategorized' : categoryParam;
  const transactionType = readParam(params.type) as TransactionType | undefined;

  // Built with `if` guards on a mutable local shape rather than merged
  // conditional spreads — `exactOptionalPropertyTypes` loses precision when
  // several `...(cond ? { key } : {})` spreads are combined into one object
  // literal, even though each is fine on its own (see CLAUDE.md).
  const reviewFilters: {
    status: StatusFilter;
    accountId?: string;
    categoryId?: string;
    transactionType?: TransactionType;
  } = { status };
  if (accountId) reviewFilters.accountId = accountId;
  if (categoryId) reviewFilters.categoryId = categoryId;
  if (transactionType) reviewFilters.transactionType = transactionType;

  const [transactions, accounts, categories] = await Promise.all([
    listTransactionsForReview(owner.userId, reviewFilters),
    listAccounts(owner.userId),
    listCategories(owner.userId),
  ]);

  return (
    <div>
      <h1 className="text-xl font-semibold">Review</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Anything M6 could not confidently resolve on its own. Fix what needs it; the rest stays out
        of your way.
      </p>

      <ReviewQueue
        transactions={transactions}
        accounts={accounts}
        categories={categories}
        filters={reviewFilters}
      />
    </div>
  );
}
