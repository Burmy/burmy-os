import type { Metadata } from 'next';

import { PageHeader } from '@/components/ui/page-header';
import { ReviewQueue } from '@/features/finance/review/review-queue';
import { requireOwner } from '@/server/auth/owner';
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
  const categoryParam = readParam(params.category);
  const categoryId = categoryParam === 'uncategorized' ? 'uncategorized' : categoryParam;
  const transactionType = readParam(params.type) as TransactionType | undefined;

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

  const [transactions, categories] = await Promise.all([
    listTransactionsForReview(owner.userId, reviewFilters),
    listCategories(owner.userId),
  ]);

  return (
    <div>
      <PageHeader
        title="Review"
        subtitle="Anything M6 could not confidently resolve on its own. Fix what needs it; the rest stays out of your way."
      />

      <ReviewQueue transactions={transactions} categories={categories} filters={reviewFilters} />
    </div>
  );
}
