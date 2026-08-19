import { randomUUID } from 'node:crypto';

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { harness, resetDatabase } from './harness';

/**
 * `resolveHiddenAccount()` (round-2 UX pass, item 2) — accounts are no
 * longer user-managed; this is the ONE way an account is ever created now,
 * routing an upload to a hidden per-type account automatically. Against real
 * Postgres because the whole point is proving idempotent reuse (a second
 * import of the same type must NOT create a second account) and that two
 * different types land on two DIFFERENT accounts, which the counterpart-match
 * mechanism (`classify/counterpart.ts`) still depends on.
 */
type Accounts = typeof import('@/server/db/finance/accounts');

let accounts: Accounts;

beforeAll(async () => {
  await harness();
  accounts = await import('@/server/db/finance/accounts');
});

beforeEach(async () => {
  await resetDatabase();
});

async function makeOwner(email: string): Promise<string> {
  const { sql } = await harness();
  const id = randomUUID();
  await sql`insert into "user" ("id", "name", "email", "email_verified") values (${id}, ${email}, ${email}, true)`;
  return id;
}

describe('resolveHiddenAccount', () => {
  it('creates a checking account on first use, named plainly', async () => {
    const owner = await makeOwner('owner@burmy.test');

    const account = await accounts.resolveHiddenAccount(owner, 'checking');

    expect(account.type).toBe('checking');
    expect(account.name).toBe('Checking');
    expect(account.institution).toBeNull();
    expect(account.isActive).toBe(true);
  });

  it('creates a credit_card account on first use, named plainly', async () => {
    const owner = await makeOwner('owner@burmy.test');

    const account = await accounts.resolveHiddenAccount(owner, 'credit_card');

    expect(account.type).toBe('credit_card');
    expect(account.name).toBe('Credit Card');
  });

  it('reuses the same account on a second call — idempotent, not a duplicate', async () => {
    const owner = await makeOwner('owner@burmy.test');

    const first = await accounts.resolveHiddenAccount(owner, 'checking');
    const second = await accounts.resolveHiddenAccount(owner, 'checking');

    expect(second.id).toBe(first.id);
    const all = await accounts.listAccounts(owner);
    expect(all).toHaveLength(1);
  });

  it('routes checking and credit_card to two distinct accounts', async () => {
    const owner = await makeOwner('owner@burmy.test');

    const checking = await accounts.resolveHiddenAccount(owner, 'checking');
    const card = await accounts.resolveHiddenAccount(owner, 'credit_card');

    expect(checking.id).not.toBe(card.id);
    const all = await accounts.listAccounts(owner);
    expect(all).toHaveLength(2);
  });

  it('is scoped per owner — two owners each get their own hidden account', async () => {
    const alice = await makeOwner('alice@burmy.test');
    const bob = await makeOwner('bob@burmy.test');

    const aliceAccount = await accounts.resolveHiddenAccount(alice, 'checking');
    const bobAccount = await accounts.resolveHiddenAccount(bob, 'checking');

    expect(aliceAccount.id).not.toBe(bobAccount.id);
  });
});
