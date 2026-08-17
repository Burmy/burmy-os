import { describe, expect, it } from 'vitest';

import {
  type CounterpartCandidate,
  dateWindow,
  extractConfirmationToken,
  findQualifyingCounterpart,
} from '@/server/finance/classify/counterpart';

describe('extractConfirmationToken', () => {
  it('extracts from the checking-side "Confirmation#" form, with a space', () => {
    expect(extractConfirmationToken('Online Banking payment to CRD 9903 Confirmation# 4p9dnrwz6')).toBe(
      '4p9dnrwz6',
    );
  });

  it('extracts from the card-side "CONF#" form, with no space', () => {
    expect(extractConfirmationToken('PAYMENT FROM CHK 2288 CONF#4p9dnrwz6')).toBe('4p9dnrwz6');
  });

  it('is case-insensitive on the prefix and lowercases the token, so both forms compare equal', () => {
    expect(extractConfirmationToken('conf#AbC123')).toBe('abc123');
    expect(extractConfirmationToken('CONFIRMATION# AbC123')).toBe('abc123');
  });

  it('returns null when there is no confirmation marker at all', () => {
    expect(extractConfirmationToken('SUMMIT CREDIT CRD DES:AUTOPAY ID:000000000417338')).toBeNull();
    expect(extractConfirmationToken('')).toBeNull();
  });
});

describe('dateWindow', () => {
  it('computes a symmetric ±N day window', () => {
    expect(dateWindow('2026-05-15', 7)).toEqual({ start: '2026-05-08', end: '2026-05-22' });
  });

  it('crosses a month boundary correctly', () => {
    expect(dateWindow('2026-05-03', 7)).toEqual({ start: '2026-04-26', end: '2026-05-10' });
  });

  it('crosses a year boundary correctly', () => {
    expect(dateWindow('2026-01-02', 7)).toEqual({ start: '2025-12-26', end: '2026-01-09' });
  });
});

describe('findQualifyingCounterpart', () => {
  const checkingLeg: CounterpartCandidate = {
    id: 'card-txn',
    amountCents: -8815,
    description: 'PAYMENT FROM CHK 2288 CONF#4p9dnrwz6',
    accountType: 'credit_card',
  };

  it('matches on token + exact negated amount, labelling credit_card_payment when either side is a card', () => {
    const match = findQualifyingCounterpart('4p9dnrwz6', 8815, 'checking', [checkingLeg]);
    expect(match).toEqual({ id: 'card-txn', transactionType: 'credit_card_payment' });
  });

  it('resolves credit_card_payment even when THIS side (not the candidate) is the card account', () => {
    // Importing the card statement second: the candidate is the checking leg,
    // not a credit_card account, but the label must still be card payment.
    const checkingCandidate: CounterpartCandidate = {
      id: 'checking-txn',
      amountCents: 8815,
      description: 'Online Banking payment to CRD 9903 Confirmation# 4p9dnrwz6',
      accountType: 'checking',
    };
    const match = findQualifyingCounterpart('4p9dnrwz6', -8815, 'credit_card', [checkingCandidate]);
    expect(match).toEqual({ id: 'checking-txn', transactionType: 'credit_card_payment' });
  });

  it('labels transfer when neither side is a credit_card account', () => {
    const savingsCandidate: CounterpartCandidate = {
      id: 'savings-txn',
      amountCents: -54025,
      description: 'Online Banking transfer from CHK 2288 Confirmation# 4029518337',
      accountType: 'savings',
    };
    const match = findQualifyingCounterpart('4029518337', 54025, 'checking', [savingsCandidate]);
    expect(match).toEqual({ id: 'savings-txn', transactionType: 'transfer' });
  });

  it('returns null with zero candidates — the safe default, never a guess', () => {
    expect(findQualifyingCounterpart('4p9dnrwz6', 8815, 'checking', [])).toBeNull();
  });

  it('returns null when the candidate amount is not the EXACT negation (same sign, or different magnitude)', () => {
    const sameSign: CounterpartCandidate = { ...checkingLeg, amountCents: 8815 };
    const wrongMagnitude: CounterpartCandidate = { ...checkingLeg, amountCents: -8816 };
    expect(findQualifyingCounterpart('4p9dnrwz6', 8815, 'checking', [sameSign])).toBeNull();
    expect(findQualifyingCounterpart('4p9dnrwz6', 8815, 'checking', [wrongMagnitude])).toBeNull();
  });

  it('returns null when the candidate token does not EXACTLY match — protects against an ILIKE substring false positive', () => {
    // The SQL pre-filter is a substring ILIKE; this candidate's real token
    // merely CONTAINS the search token as a substring and must be rejected.
    const substringCollision: CounterpartCandidate = {
      ...checkingLeg,
      description: 'PAYMENT FROM CHK 2288 CONF#94p9dnrwz6x',
    };
    expect(findQualifyingCounterpart('4p9dnrwz6', 8815, 'checking', [substringCollision])).toBeNull();
  });

  it('returns null when more than one candidate qualifies — ambiguous, so no classification at all', () => {
    const duplicate: CounterpartCandidate = { ...checkingLeg, id: 'card-txn-2' };
    expect(findQualifyingCounterpart('4p9dnrwz6', 8815, 'checking', [checkingLeg, duplicate])).toBeNull();
  });
});
