import { describe, expect, it } from 'vitest';

import {
  EXCLUSIONARY_TRANSACTION_TYPES,
  MANUAL_TRANSACTION_TYPES,
  isExclusionaryType,
  reviewStatusForCorrection,
} from '@/server/finance/classify/manual';

describe('isExclusionaryType', () => {
  it('is true for transfer, credit_card_payment, and investment', () => {
    for (const type of EXCLUSIONARY_TRANSACTION_TYPES) {
      expect(isExclusionaryType(type)).toBe(true);
    }
  });

  it('is false for expense, income, refund, fee, and adjustment', () => {
    for (const type of ['expense', 'income', 'refund', 'fee', 'adjustment']) {
      expect(isExclusionaryType(type)).toBe(false);
    }
  });
});

describe('MANUAL_TRANSACTION_TYPES', () => {
  it('excludes adjustment — not a meaningful owner-facing pick', () => {
    expect(MANUAL_TRANSACTION_TYPES).not.toContain('adjustment');
  });

  it('includes every other real transaction type exactly once', () => {
    expect([...MANUAL_TRANSACTION_TYPES].sort()).toEqual(
      ['credit_card_payment', 'expense', 'fee', 'income', 'investment', 'refund', 'transfer'].sort(),
    );
  });
});

describe('reviewStatusForCorrection', () => {
  it('is confirmed once a category is set, for an ordinary (non-exclusionary) type', () => {
    expect(reviewStatusForCorrection('cat-1', 'expense')).toBe('confirmed');
    expect(reviewStatusForCorrection('cat-1', 'income')).toBe('confirmed');
  });

  it('is needs_review with no category, for an ordinary type — never confirmed-but-uncategorized', () => {
    expect(reviewStatusForCorrection(null, 'expense')).toBe('needs_review');
    expect(reviewStatusForCorrection(null, 'income')).toBe('needs_review');
    expect(reviewStatusForCorrection(null, 'refund')).toBe('needs_review');
    expect(reviewStatusForCorrection(null, 'fee')).toBe('needs_review');
  });

  it('is confirmed with NO category when the type is exclusionary — nothing to categorize', () => {
    expect(reviewStatusForCorrection(null, 'transfer')).toBe('confirmed');
    expect(reviewStatusForCorrection(null, 'credit_card_payment')).toBe('confirmed');
    expect(reviewStatusForCorrection(null, 'investment')).toBe('confirmed');
  });

  it('is confirmed for an exclusionary type even WITH a category — the two are independent', () => {
    expect(reviewStatusForCorrection('cat-1', 'transfer')).toBe('confirmed');
  });
});
