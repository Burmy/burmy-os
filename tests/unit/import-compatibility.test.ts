import { describe, expect, it } from 'vitest';

import {
  AccountFormatMismatchError,
  assertAccountCompatible,
  isAccountCompatible,
} from '@/server/finance/import/compatibility';

/**
 * Account/format compatibility — pure, no DB.
 *
 * The scenario this guards: a card export staged against a checking account
 * would parse cleanly (the parser has no idea which account the owner meant)
 * and every row would carry a plausible-looking WRONG account_id, silently
 * misfiling a month of spending with nothing downstream noticing. See
 * compatibility.ts.
 */
describe('isAccountCompatible', () => {
  it('accepts a BoA deposit export against checking or savings', () => {
    expect(isAccountCompatible('boa-deposit', 'checking')).toBe(true);
    expect(isAccountCompatible('boa-deposit', 'savings')).toBe(true);
  });

  it('accepts a BoA card export only against a credit card account', () => {
    expect(isAccountCompatible('boa-card', 'credit_card')).toBe(true);
  });

  it('rejects a card export against checking, and a deposit export against a card account', () => {
    expect(isAccountCompatible('boa-card', 'checking')).toBe(false);
    expect(isAccountCompatible('boa-deposit', 'credit_card')).toBe(false);
  });

  it('rejects a deposit export against brokerage — no export produces that shape', () => {
    expect(isAccountCompatible('boa-deposit', 'brokerage')).toBe(false);
    expect(isAccountCompatible('boa-card', 'brokerage')).toBe(false);
  });

  it('never marks the generic (unrecognized) format compatible with anything', () => {
    for (const type of ['checking', 'savings', 'credit_card', 'brokerage'] as const) {
      expect(isAccountCompatible('generic', type)).toBe(false);
    }
  });
});

describe('assertAccountCompatible', () => {
  it('does not throw for a matching pair', () => {
    expect(() => assertAccountCompatible('boa-deposit', 'checking')).not.toThrow();
  });

  it('throws AccountFormatMismatchError naming both the format and the account', () => {
    try {
      assertAccountCompatible('boa-card', 'checking');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AccountFormatMismatchError);
      const message = (error as AccountFormatMismatchError).message;
      expect(message).toMatch(/credit card export/i);
      expect(message).toMatch(/checking account/i);
    }
  });
});
