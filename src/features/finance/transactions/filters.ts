import { isUuid } from '@/lib/uuid';
import type { LedgerFilters } from '@/server/db/finance/transactions';
import type { ReviewStatus, TransactionType } from '@/server/db/finance/transactions';

/**
 * Shared between the Transactions page (a Server Component reading Next's
 * `searchParams`) and the export Route Handler (reading a plain
 * `URLSearchParams`) — both normalize to this shape first, so the two entry
 * points can never interpret the same query string two different ways. That
 * is what makes "export exactly the current filter" true by construction
 * rather than by two independently-written parsers happening to agree.
 */
export interface RawLedgerParams {
  readonly year?: string;
  readonly month?: string;
  readonly category?: string;
  readonly type?: string;
  readonly status?: string;
  readonly q?: string;
  readonly page?: string;
}

/** All 8 real `transaction_type` values — unlike M7's `MANUAL_TRANSACTION_TYPES`, a ledger FILTER should find an old `adjustment` row too, even though nothing lets you newly hand-assign one. */
export const LEDGER_TRANSACTION_TYPES = [
  'expense',
  'refund',
  'fee',
  'adjustment',
  'income',
  'transfer',
  'credit_card_payment',
  'investment',
] as const;

const REVIEW_STATUS_VALUES: readonly ReviewStatus[] = ['needs_review', 'auto', 'confirmed'];

export function parseLedgerFilters(
  raw: RawLedgerParams,
  fallbackYear: number,
): { readonly filters: LedgerFilters; readonly page: number } {
  const parsedYear = raw.year ? Number.parseInt(raw.year, 10) : NaN;
  const year = Number.isFinite(parsedYear) && parsedYear >= 2000 && parsedYear <= 2100 ? parsedYear : fallbackYear;

  // Built with `if` guards on a mutable local shape rather than merged
  // conditional spreads — `exactOptionalPropertyTypes` loses precision once
  // several `...(cond ? { key } : {})` spreads combine into one literal (see
  // CLAUDE.md), and there are five independently-optional fields here.
  const filters: {
    year: number;
    month?: number;
    categoryId?: string;
    transactionType?: TransactionType;
    reviewStatus?: ReviewStatus | 'all';
    search?: string;
  } = { year };

  const parsedMonth = raw.month ? Number.parseInt(raw.month, 10) : NaN;
  if (Number.isFinite(parsedMonth) && parsedMonth >= 1 && parsedMonth <= 12) filters.month = parsedMonth;

  // THE SHAPE IS CHECKED, NOT JUST THE PRESENCE. `categoryId` reaches
  // `eq(financeTransactions.categoryId, …)` against a `uuid` column, and
  // Postgres answers a non-uuid by RAISING (`22P02`), which surfaces as a 500
  // on a hand-edited link rather than as an ignored filter. Every other param
  // in this function already drops a value it does not recognise; this one
  // simply never checked. A well-formed id that does not exist — or belongs
  // to someone else — is a different case and still handled the same way it
  // always was: the owner-scoped query returns nothing.
  if (raw.category === 'uncategorized') filters.categoryId = 'uncategorized';
  else if (raw.category && isUuid(raw.category)) filters.categoryId = raw.category;

  if (raw.type && (LEDGER_TRANSACTION_TYPES as readonly string[]).includes(raw.type)) {
    filters.transactionType = raw.type as TransactionType;
  }

  if (raw.status === 'all') filters.reviewStatus = 'all';
  else if (raw.status && (REVIEW_STATUS_VALUES as readonly string[]).includes(raw.status)) {
    filters.reviewStatus = raw.status as ReviewStatus;
  }

  const search = raw.q?.trim();
  if (search) filters.search = search;

  const parsedPage = raw.page ? Number.parseInt(raw.page, 10) : NaN;
  const page = Number.isFinite(parsedPage) && parsedPage >= 1 ? parsedPage : 1;

  return { filters, page };
}
