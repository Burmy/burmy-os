import { describe, expect, it } from 'vitest';

import { LEDGER_TRANSACTION_TYPES, parseLedgerFilters } from '@/features/finance/transactions/filters';
import { isUuid } from '@/lib/uuid';

/**
 * `parseLedgerFilters` is the URL boundary for the Transactions page AND its
 * export Route Handler — the one place a hand-edited query string turns into
 * values that reach SQL. Every param it does not recognise must be DROPPED,
 * because a `uuid` or enum column answers a bad value by raising `22P02`,
 * which renders as a 500 rather than as an ignored filter.
 *
 * `category` was the param that had no such check, which is what these tests
 * were written for; the rest are here so the next param added to this
 * function has a pattern to copy.
 */

const FALLBACK_YEAR = 2026;
const CATEGORY_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const parse = (raw: Parameters<typeof parseLedgerFilters>[0]) => parseLedgerFilters(raw, FALLBACK_YEAR);

describe('isUuid', () => {
  it('accepts a real uuid regardless of case', () => {
    expect(isUuid(CATEGORY_ID)).toBe(true);
    expect(isUuid(CATEGORY_ID.toUpperCase())).toBe(true);
  });

  it('accepts the nil uuid', () => {
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
  });

  it('rejects the shapes a hand-edited URL actually produces', () => {
    expect(isUuid('garbage')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid('uncategorized')).toBe(false);
    // Truncated by a line-wrapped paste — the most likely real-world case.
    expect(isUuid(CATEGORY_ID.slice(0, 30))).toBe(false);
    // Right shape, wrong alphabet.
    expect(isUuid('zzzzzzzz-4f89-41d3-9a0c-0305e82c3301')).toBe(false);
    // Trailing whitespace or a stray character is still not a uuid.
    expect(isUuid(`${CATEGORY_ID} `)).toBe(false);
    expect(isUuid(`${CATEGORY_ID}'`)).toBe(false);
  });
});

describe('parseLedgerFilters — category', () => {
  it('keeps a well-formed category id', () => {
    expect(parse({ category: CATEGORY_ID }).filters.categoryId).toBe(CATEGORY_ID);
  });

  it('keeps the "uncategorized" sentinel, which is not a uuid', () => {
    expect(parse({ category: 'uncategorized' }).filters.categoryId).toBe('uncategorized');
  });

  it('DROPS a non-uuid instead of passing it to a uuid column', () => {
    // Before this guard, the value reached `eq(financeTransactions.categoryId, …)`
    // and Postgres raised `22P02 invalid input syntax for type uuid`, which
    // surfaced as a 500 on both /finance/transactions and /finance/review.
    expect(parse({ category: 'garbage' }).filters.categoryId).toBeUndefined();
    expect(parse({ category: "' or 1=1--" }).filters.categoryId).toBeUndefined();
  });

  it('leaves the filter off entirely when the param is absent', () => {
    expect(parse({}).filters.categoryId).toBeUndefined();
  });
});

describe('parseLedgerFilters — everything else it drops', () => {
  it('falls back to the given year for a non-numeric or out-of-range year', () => {
    expect(parse({ year: 'garbage' }).filters.year).toBe(FALLBACK_YEAR);
    expect(parse({ year: '1200' }).filters.year).toBe(FALLBACK_YEAR);
    expect(parse({ year: '2024' }).filters.year).toBe(2024);
  });

  it('drops a month outside 1–12', () => {
    expect(parse({ month: '0' }).filters.month).toBeUndefined();
    expect(parse({ month: '13' }).filters.month).toBeUndefined();
    expect(parse({ month: 'garbage' }).filters.month).toBeUndefined();
    expect(parse({ month: '7' }).filters.month).toBe(7);
  });

  it('drops an unknown transaction type', () => {
    expect(parse({ type: 'garbage' }).filters.transactionType).toBeUndefined();
    for (const type of LEDGER_TRANSACTION_TYPES) {
      expect(parse({ type }).filters.transactionType).toBe(type);
    }
  });

  it('drops an unknown review status', () => {
    expect(parse({ status: 'garbage' }).filters.reviewStatus).toBeUndefined();
    expect(parse({ status: 'all' }).filters.reviewStatus).toBe('all');
    expect(parse({ status: 'needs_review' }).filters.reviewStatus).toBe('needs_review');
  });

  it('always returns a page of at least 1', () => {
    expect(parse({ page: 'garbage' }).page).toBe(1);
    expect(parse({ page: '0' }).page).toBe(1);
    expect(parse({ page: '-4' }).page).toBe(1);
    expect(parse({ page: '3' }).page).toBe(3);
  });

  it('drops a search that is only whitespace', () => {
    expect(parse({ q: '   ' }).filters.search).toBeUndefined();
    expect(parse({ q: '  costco ' }).filters.search).toBe('costco');
  });
});
