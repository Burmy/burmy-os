import { describe, expect, it } from 'vitest';

import { defaultAccountTypeFor } from '@/server/finance/import/account-type';

describe('defaultAccountTypeFor', () => {
  it('resolves a BoA deposit export to checking', () => {
    expect(defaultAccountTypeFor('boa-deposit')).toBe('checking');
  });

  it('resolves a BoA card export to credit_card', () => {
    expect(defaultAccountTypeFor('boa-card')).toBe('credit_card');
  });
});
