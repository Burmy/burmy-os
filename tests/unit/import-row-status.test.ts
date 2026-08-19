import { describe, expect, it } from 'vitest';

import type { FinanceImportRowView } from '@/server/db/finance/imports';
import { rowBucket, rowReason } from '@/features/finance/import/row-status';

/** A fully "ready" row by default — every test overrides only what it's testing. */
function makeRow(overrides: Partial<FinanceImportRowView> = {}): FinanceImportRowView {
  return {
    id: 'row-1',
    rowNumber: 1,
    transactionDate: '2026-05-15',
    postedDate: null,
    description: 'MERCHANT 1',
    normalizedMerchant: 'MERCHANT 1',
    amountCents: 1000,
    sourceCategory: null,
    decision: 'include',
    decisionOverridden: false,
    duplicateOfTransactionId: null,
    categoryId: 'category-1',
    categorizationSource: 'merchant_memory',
    suggestedType: null,
    typeOverridden: false,
    reviewNote: null,
    parseError: null,
    ...overrides,
  };
}

describe('rowBucket', () => {
  it('a parse failure is always "attention", regardless of anything else', () => {
    expect(rowBucket(makeRow({ parseError: 'could not parse amount' }))).toBe('attention');
    expect(
      rowBucket(makeRow({ parseError: 'bad row', decision: 'exclude', categoryId: 'category-1' })),
    ).toBe('attention');
  });

  it('a system-defaulted exclude (Tier 1/2 dedupe, untouched) is "duplicate"', () => {
    expect(rowBucket(makeRow({ decision: 'exclude', decisionOverridden: false }))).toBe('duplicate');
  });

  it('an OWNER-initiated exclude is "excluded", not "duplicate" — the bug this bucket logic fixes', () => {
    const row = makeRow({ decision: 'exclude', decisionOverridden: true, categoryId: null });
    expect(rowBucket(row)).toBe('excluded');
    // Specifically: it must NOT fall through to "attention" just because
    // categoryId is null — that was the original, incorrect draft's bug.
    expect(rowBucket(row)).not.toBe('attention');
  });

  it('a row the counterpart preview flags as transfer/card payment is "excluded"', () => {
    expect(rowBucket(makeRow({ suggestedType: 'credit_card_payment' }))).toBe('excluded');
    expect(rowBucket(makeRow({ suggestedType: 'transfer' }))).toBe('excluded');
  });

  it('an uncategorized, otherwise-ordinary row is "attention"', () => {
    expect(rowBucket(makeRow({ categoryId: null }))).toBe('attention');
  });

  it('a categorized, included, non-excluded row is "ready"', () => {
    expect(rowBucket(makeRow())).toBe('ready');
  });

  it('decision/exclude is checked before suggestedType — a manually excluded card-payment row is "excluded" either way, not double-counted', () => {
    const row = makeRow({
      decision: 'exclude',
      decisionOverridden: true,
      suggestedType: 'credit_card_payment',
    });
    expect(rowBucket(row)).toBe('excluded');
  });
});

describe('rowReason', () => {
  it('a parse failure reports the actual error message, not a generic label', () => {
    expect(rowReason(makeRow({ parseError: 'amount column missing' }), 'attention')).toBe(
      'amount column missing',
    );
  });

  it('Ready is truthful about WHY: manual pick vs. an untouched suggestion', () => {
    expect(rowReason(makeRow({ categorizationSource: 'manual' }), 'ready')).toBe('Ready — category selected');
    expect(rowReason(makeRow({ categorizationSource: 'merchant_memory' }), 'ready')).toBe(
      'Ready — auto-categorized',
    );
  });

  it('Needs attention reports uncategorized', () => {
    expect(rowReason(makeRow({ categoryId: null }), 'attention')).toBe('Needs attention — uncategorized');
  });

  it('Duplicate reports already imported', () => {
    expect(rowReason(makeRow({ decision: 'exclude' }), 'duplicate')).toBe('Duplicate — already imported');
  });

  it('Excluded distinguishes card payment, transfer, and a plain manual exclude', () => {
    expect(rowReason(makeRow({ suggestedType: 'credit_card_payment' }), 'excluded')).toBe(
      'Excluded — card payment',
    );
    expect(rowReason(makeRow({ suggestedType: 'transfer' }), 'excluded')).toBe('Excluded — transfer');
    expect(rowReason(makeRow({ decision: 'exclude', decisionOverridden: true }), 'excluded')).toBe(
      'Excluded — manually excluded',
    );
  });
});
