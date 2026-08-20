import { describe, expect, it } from 'vitest';

import { cents } from '@/server/finance/money';
import {
  defaultTransactionType,
  parseBoaCardAddressHint,
  planStagedDecisions,
  reviewStatusFor,
} from '@/server/finance/import/staging';

describe('planStagedDecisions', () => {
  it('marks a brand-new key entirely new, with no committed match', () => {
    const decisions = planStagedDecisions([{ rowNumber: 1, dedupeKey: 'a' }], new Map());
    expect(decisions).toEqual([{ rowNumber: 1, decision: 'include', duplicateOfTransactionId: null }]);
  });

  it('excludes a key already fully covered by committed history', () => {
    const decisions = planStagedDecisions(
      [{ rowNumber: 1, dedupeKey: 'a' }],
      new Map([['a', { count: 1, sampleTransactionId: 'txn-1' }]]),
    );
    expect(decisions).toEqual([
      { rowNumber: 1, decision: 'exclude', duplicateOfTransactionId: 'txn-1' },
    ]);
  });

  it('preserves a genuine same-day repeat: surplus beyond the committed count is new', () => {
    // Two identical $5 coffees share a dedupe key. One is already committed —
    // the second staged occurrence must still default to new, not duplicate.
    const decisions = planStagedDecisions(
      [
        { rowNumber: 1, dedupeKey: 'coffee' },
        { rowNumber: 2, dedupeKey: 'coffee' },
      ],
      new Map([['coffee', { count: 1, sampleTransactionId: 'txn-1' }]]),
    );

    expect(decisions.filter((d) => d.decision === 'include')).toHaveLength(1);
    expect(decisions.filter((d) => d.decision === 'exclude')).toHaveLength(1);
  });

  it('picks the surplus by rowNumber order, deterministically', () => {
    // One committed match, two staged candidates sharing the key — exactly one
    // is surplus, and it must be the LOWER rowNumber regardless of input order.
    const decisions = planStagedDecisions(
      [
        { rowNumber: 5, dedupeKey: 'k' },
        { rowNumber: 2, dedupeKey: 'k' },
      ],
      new Map([['k', { count: 1, sampleTransactionId: 'txn-1' }]]),
    );

    expect(decisions.find((d) => d.decision === 'include')?.rowNumber).toBe(2);
    expect(decisions.find((d) => d.decision === 'exclude')?.rowNumber).toBe(5);
  });

  it('reconciles each dedupe key independently', () => {
    const decisions = planStagedDecisions(
      [
        { rowNumber: 1, dedupeKey: 'a' },
        { rowNumber: 2, dedupeKey: 'b' },
      ],
      new Map([['a', { count: 1, sampleTransactionId: 'txn-a' }]]),
    );

    expect(decisions.find((d) => d.rowNumber === 1)?.decision).toBe('exclude');
    expect(decisions.find((d) => d.rowNumber === 2)?.decision).toBe('include');
  });

  it('is a no-op for an empty batch', () => {
    expect(planStagedDecisions([], new Map())).toEqual([]);
  });
});

describe('defaultTransactionType', () => {
  it('is expense for an outflow — positive cents', () => {
    expect(defaultTransactionType(cents(2500))).toBe('expense');
  });

  it('is income for an inflow — negative cents', () => {
    expect(defaultTransactionType(cents(-2500))).toBe('income');
  });

  it('never produces an exclusionary type — only expense or income exist as outcomes', () => {
    // CLAUDE.md invariant 5: transfer/credit_card_payment/investment require
    // deterministic evidence M5 does not have. Asserting the return type is
    // one of exactly two values is what keeps that true even if a future edit
    // adds a branch here without reading the invariant.
    for (const amount of [cents(1), cents(-1), cents(0), cents(999_999)]) {
      expect(['expense', 'income']).toContain(defaultTransactionType(amount));
    }
  });
});

describe('parseBoaCardAddressHint', () => {
  it('splits city and state from the padded Address column', () => {
    expect(parseBoaCardAddressHint('SPRINGFIELD   TX ')).toEqual({ city: 'SPRINGFIELD', state: 'TX' });
  });

  it('is robust to a different padding width than the observed 14 columns', () => {
    expect(parseBoaCardAddressHint('DALLAS TX')).toEqual({ city: 'DALLAS', state: 'TX' });
    expect(parseBoaCardAddressHint('  EASTVALE     CA  ')).toEqual({ city: 'EASTVALE', state: 'CA' });
  });

  it('returns undefined for a blank Address, as on payment rows', () => {
    expect(parseBoaCardAddressHint('')).toBeUndefined();
    expect(parseBoaCardAddressHint('   ')).toBeUndefined();
    expect(parseBoaCardAddressHint(undefined)).toBeUndefined();
  });

  it('returns undefined when there is no city — just two letters alone', () => {
    expect(parseBoaCardAddressHint('TX')).toBeUndefined();
  });
});

describe('reviewStatusFor', () => {
  it('is needs_review with no category at all, regardless of source', () => {
    expect(reviewStatusFor(null, null, 'expense')).toBe('needs_review');
    // A source with no category is not a state staging ever produces, but the
    // function should still treat "no category" as the deciding fact.
    expect(reviewStatusFor(null, 'merchant_memory', 'expense')).toBe('needs_review');
  });

  it('is confirmed when the OWNER picked the category', () => {
    expect(reviewStatusFor('cat-1', 'manual', 'expense')).toBe('confirmed');
  });

  it('is auto when merchant memory supplied the category and nothing overrode it', () => {
    expect(reviewStatusFor('cat-1', 'merchant_memory', 'expense')).toBe('auto');
  });

  it('is auto for income with no category — income never needs one to be resolved', () => {
    expect(reviewStatusFor(null, null, 'income')).toBe('auto');
  });

  it('still respects an explicit category on income, same as expense', () => {
    expect(reviewStatusFor('cat-1', 'manual', 'income')).toBe('confirmed');
    expect(reviewStatusFor('cat-1', 'merchant_memory', 'income')).toBe('auto');
  });
});
