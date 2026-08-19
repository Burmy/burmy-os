import { randomUUID } from 'node:crypto';

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { harness, resetDatabase } from './harness';

/**
 * M7's review queue, against real Postgres.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Transactions are seeded directly via SQL rather than through the M5/M6
 * import pipeline — this suite is about what M7's OWN corrections do to an
 * already-committed row, most importantly the counterpart-unlink, which needs
 * two specific pre-existing linked rows to exist before the action under test
 * ever runs. M5/M6's own suites already cover how a transaction gets
 * committed and matched in the first place.
 * ─────────────────────────────────────────────────────────────────────────────
 */

type Accounts = typeof import('@/server/db/finance/accounts');
type Categories = typeof import('@/server/db/finance/categories');
type Transactions = typeof import('@/server/db/finance/transactions');
type MerchantMemory = typeof import('@/server/db/finance/merchant-memory');
type Errors = typeof import('@/server/db/finance/errors');

let accounts: Accounts;
let categories: Categories;
let transactions: Transactions;
let merchantMemory: MerchantMemory;
let errors: Errors;

beforeAll(async () => {
  await harness();
  [accounts, categories, transactions, merchantMemory, errors] = await Promise.all([
    import('@/server/db/finance/accounts'),
    import('@/server/db/finance/categories'),
    import('@/server/db/finance/transactions'),
    import('@/server/db/finance/merchant-memory'),
    import('@/server/db/finance/errors'),
  ]);
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

async function makeAccountId(
  ownerId: string,
  type: 'checking' | 'savings' | 'credit_card' | 'brokerage' = 'checking',
  name?: string,
): Promise<string> {
  const account = await accounts.createAccount(ownerId, {
    name: name ?? `Test account ${randomUUID().slice(0, 8)}`,
    type,
    institution: null,
    lastFour: null,
  });
  return account.id;
}

interface SeedTxn {
  readonly ownerId: string;
  readonly accountId: string;
  readonly amountCents?: number;
  readonly date?: string;
  readonly description?: string;
  readonly normalizedMerchant?: string | null;
  readonly transactionType?: string;
  readonly typeSource?: string;
  readonly reviewStatus?: string;
  readonly categoryId?: string | null;
  readonly categorizationSource?: string | null;
  readonly counterpartTransactionId?: string | null;
}

async function seedTransaction(options: SeedTxn): Promise<string> {
  const { sql } = await harness();
  const dedupeKey = randomUUID();
  const rows = await sql<{ id: string }[]>`
    insert into "finance_transactions"
      ("owner_id", "account_id", "transaction_date", "original_description", "normalized_merchant",
       "amount_cents", "transaction_type", "type_source", "review_status", "category_id",
       "categorization_source", "counterpart_transaction_id", "dedupe_key")
    values
      (${options.ownerId}, ${options.accountId}, ${options.date ?? '2026-05-15'},
       ${options.description ?? 'TEST MERCHANT'}, ${options.normalizedMerchant ?? 'TEST MERCHANT'},
       ${options.amountCents ?? 1000}, ${options.transactionType ?? 'expense'},
       ${options.typeSource ?? 'default'}, ${options.reviewStatus ?? 'needs_review'},
       ${options.categoryId ?? null}, ${options.categorizationSource ?? null},
       ${options.counterpartTransactionId ?? null}, ${dedupeKey})
    returning "id"
  `;
  return rows[0]!.id;
}

async function linkCounterparts(aId: string, bId: string): Promise<void> {
  const { sql } = await harness();
  await sql`update "finance_transactions" set "counterpart_transaction_id" = ${bId} where "id" = ${aId}`;
  await sql`update "finance_transactions" set "counterpart_transaction_id" = ${aId} where "id" = ${bId}`;
}

async function getTransaction(id: string): Promise<{
  readonly transactionType: string;
  readonly typeSource: string;
  readonly reviewStatus: string;
  readonly categoryId: string | null;
  readonly categorizationSource: string | null;
  readonly counterpartTransactionId: string | null;
} | null> {
  const { sql } = await harness();
  const rows = await sql<
    {
      transaction_type: string;
      type_source: string;
      review_status: string;
      category_id: string | null;
      categorization_source: string | null;
      counterpart_transaction_id: string | null;
    }[]
  >`
    select "transaction_type", "type_source", "review_status", "category_id", "categorization_source",
           "counterpart_transaction_id"
    from "finance_transactions" where "id" = ${id}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    transactionType: row.transaction_type,
    typeSource: row.type_source,
    reviewStatus: row.review_status,
    categoryId: row.category_id,
    categorizationSource: row.categorization_source,
    counterpartTransactionId: row.counterpart_transaction_id,
  };
}

describe('listTransactionsForReview', () => {
  it('defaults to needs_review only', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    await seedTransaction({ ownerId: owner, accountId, reviewStatus: 'needs_review' });
    await seedTransaction({ ownerId: owner, accountId, reviewStatus: 'confirmed', categoryId: null });

    const rows = await transactions.listTransactionsForReview(owner);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reviewStatus).toBe('needs_review');
  });

  it('status "all" removes the status filter', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    await seedTransaction({ ownerId: owner, accountId, reviewStatus: 'needs_review' });
    await seedTransaction({ ownerId: owner, accountId, reviewStatus: 'confirmed' });
    await seedTransaction({ ownerId: owner, accountId, reviewStatus: 'auto' });

    const rows = await transactions.listTransactionsForReview(owner, { status: 'all' });
    expect(rows).toHaveLength(3);
  });

  it('filters by category and type, composed together', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, { name: 'Gas', slug: 'gas', kind: 'spending' });

    const match = await seedTransaction({
      ownerId: owner,
      accountId,
      transactionType: 'expense',
      categoryId: category.id,
      reviewStatus: 'confirmed',
    });
    // Same category, different type — the type filter alone must exclude it.
    await seedTransaction({
      ownerId: owner,
      accountId,
      transactionType: 'income',
      categoryId: category.id,
      reviewStatus: 'confirmed',
    });

    const rows = await transactions.listTransactionsForReview(owner, {
      status: 'all',
      categoryId: category.id,
      transactionType: 'expense',
    });
    expect(rows.map((r) => r.id)).toEqual([match]);
  });

  it('"uncategorized" filters to category_id IS NULL', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, { name: 'Gas', slug: 'gas', kind: 'spending' });
    const uncategorized = await seedTransaction({
      ownerId: owner,
      accountId,
      reviewStatus: 'confirmed',
      transactionType: 'transfer',
    });
    await seedTransaction({ ownerId: owner, accountId, reviewStatus: 'confirmed', categoryId: category.id });

    const rows = await transactions.listTransactionsForReview(owner, {
      status: 'all',
      categoryId: 'uncategorized',
    });
    expect(rows.map((r) => r.id)).toEqual([uncategorized]);
  });

  it('surfaces the counterpart account name when a link exists', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const checkingId = await makeAccountId(owner, 'checking', 'Checking');
    const cardId = await makeAccountId(owner, 'credit_card', 'Card');
    const a = await seedTransaction({
      ownerId: owner,
      accountId: checkingId,
      transactionType: 'credit_card_payment',
      typeSource: 'counterpart_match',
      reviewStatus: 'auto',
    });
    const b = await seedTransaction({
      ownerId: owner,
      accountId: cardId,
      transactionType: 'credit_card_payment',
      typeSource: 'counterpart_match',
      reviewStatus: 'auto',
    });
    await linkCounterparts(a, b);

    const rows = await transactions.listTransactionsForReview(owner, { status: 'all' });
    const rowA = rows.find((r) => r.id === a);
    expect(rowA?.counterpartAccountName).toBe('Card');
  });
});

describe('getNeedsReviewCount', () => {
  it('counts only needs_review, scoped to the owner', async () => {
    const alice = await makeOwner('alice@burmy.test');
    const bob = await makeOwner('bob@burmy.test');
    const aliceAccount = await makeAccountId(alice);
    const bobAccount = await makeAccountId(bob);

    await seedTransaction({ ownerId: alice, accountId: aliceAccount, reviewStatus: 'needs_review' });
    await seedTransaction({ ownerId: alice, accountId: aliceAccount, reviewStatus: 'needs_review' });
    await seedTransaction({ ownerId: alice, accountId: aliceAccount, reviewStatus: 'confirmed' });
    await seedTransaction({ ownerId: bob, accountId: bobAccount, reviewStatus: 'needs_review' });

    expect(await transactions.getNeedsReviewCount(alice)).toBe(2);
    expect(await transactions.getNeedsReviewCount(bob)).toBe(1);
  });
});

describe('updateTransactionCategory — the no-confirmed-but-uncategorized rule', () => {
  it('assigning a category on an ordinary type confirms it', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, { name: 'Gas', slug: 'gas', kind: 'spending' });
    const id = await seedTransaction({ ownerId: owner, accountId, reviewStatus: 'needs_review' });

    await transactions.updateTransactionCategory(owner, id, category.id, false);

    const txn = await getTransaction(id);
    expect(txn?.categoryId).toBe(category.id);
    expect(txn?.categorizationSource).toBe('manual');
    expect(txn?.reviewStatus).toBe('confirmed');
  });

  it('clearing the category on an ordinary type returns it to needs_review, never confirmed-but-uncategorized', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, { name: 'Gas', slug: 'gas', kind: 'spending' });
    const id = await seedTransaction({
      ownerId: owner,
      accountId,
      categoryId: category.id,
      categorizationSource: 'manual',
      reviewStatus: 'confirmed',
    });

    await transactions.updateTransactionCategory(owner, id, null, false);

    const txn = await getTransaction(id);
    expect(txn?.categoryId).toBeNull();
    expect(txn?.categorizationSource).toBeNull();
    expect(txn?.reviewStatus).toBe('needs_review');
  });

  it('clearing the category on an EXCLUSIONARY type still confirms — nothing to categorize', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const id = await seedTransaction({
      ownerId: owner,
      accountId,
      transactionType: 'transfer',
      typeSource: 'counterpart_match',
      categoryId: null,
      reviewStatus: 'auto',
    });

    await transactions.updateTransactionCategory(owner, id, null, false);

    const txn = await getTransaction(id);
    expect(txn?.reviewStatus).toBe('confirmed');
  });

  it('rejects an id belonging to another owner', async () => {
    const alice = await makeOwner('alice@burmy.test');
    const bob = await makeOwner('bob@burmy.test');
    const aliceAccount = await makeAccountId(alice);
    const id = await seedTransaction({ ownerId: alice, accountId: aliceAccount });

    await expect(transactions.updateTransactionCategory(bob, id, null, false)).rejects.toThrow(
      errors.NotFoundError,
    );
  });
});

describe('updateTransactionCategory — remember for future imports', () => {
  it('unchecked (default): no merchant memory write', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, {
      name: 'Gifts',
      slug: 'gifts',
      kind: 'spending',
    });
    const id = await seedTransaction({
      ownerId: owner,
      accountId,
      normalizedMerchant: 'AMAZON',
    });

    await transactions.updateTransactionCategory(owner, id, category.id, false);

    const remembered = await merchantMemory.getMerchantMemoryForKeys(owner, ['AMAZON']);
    expect(remembered.size).toBe(0);
  });

  it('checked: upserts merchant memory, rederiving the key from normalized_merchant', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, {
      name: 'Shopping',
      slug: 'shopping',
      kind: 'spending',
    });
    const id = await seedTransaction({
      ownerId: owner,
      accountId,
      normalizedMerchant: 'AMAZON',
    });

    await transactions.updateTransactionCategory(owner, id, category.id, true);

    const remembered = await merchantMemory.getMerchantMemoryForKeys(owner, ['AMAZON']);
    expect(remembered.get('AMAZON')?.categoryId).toBe(category.id);
  });
});

describe('updateTransactionType — simple case, no counterpart', () => {
  it('sets manual_confirmation and the review-status rule applies', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const id = await seedTransaction({ ownerId: owner, accountId, reviewStatus: 'needs_review' });

    await transactions.updateTransactionType(owner, id, 'transfer');

    const txn = await getTransaction(id);
    expect(txn?.transactionType).toBe('transfer');
    expect(txn?.typeSource).toBe('manual_confirmation');
    expect(txn?.reviewStatus).toBe('confirmed');
  });

  it('correcting an exclusionary type BACK to an ordinary one, with no category, returns to needs_review', async () => {
    // The realistic "I fixed a wrong auto-classification" case, no pair
    // involved: an owner decides a plain expense was wrongly typed and
    // corrects it — if it still has no category, it must re-enter the queue,
    // not sail through to confirmed.
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const id = await seedTransaction({
      ownerId: owner,
      accountId,
      transactionType: 'investment',
      typeSource: 'default',
      reviewStatus: 'confirmed',
    });

    await transactions.updateTransactionType(owner, id, 'expense');

    const txn = await getTransaction(id);
    expect(txn?.transactionType).toBe('expense');
    expect(txn?.reviewStatus).toBe('needs_review');
  });
});

describe('updateTransactionType — the counterpart unlink', () => {
  it('correcting one leg atomically unlinks BOTH sides, with no stale link either direction', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const checkingId = await makeAccountId(owner, 'checking', 'Checking');
    const cardId = await makeAccountId(owner, 'credit_card', 'Card');

    const checkingLeg = await seedTransaction({
      ownerId: owner,
      accountId: checkingId,
      amountCents: 5000,
      transactionType: 'credit_card_payment',
      typeSource: 'counterpart_match',
      reviewStatus: 'auto',
    });
    const cardLeg = await seedTransaction({
      ownerId: owner,
      accountId: cardId,
      amountCents: -5000,
      transactionType: 'credit_card_payment',
      typeSource: 'counterpart_match',
      reviewStatus: 'auto',
    });
    await linkCounterparts(checkingLeg, cardLeg);

    // The owner decides the checking leg was actually a plain expense.
    await transactions.updateTransactionType(owner, checkingLeg, 'expense');

    const correctedLeg = await getTransaction(checkingLeg);
    expect(correctedLeg?.transactionType).toBe('expense');
    expect(correctedLeg?.typeSource).toBe('manual_confirmation');
    expect(correctedLeg?.counterpartTransactionId).toBeNull();
    // No category was ever set on it, and 'expense' is not exclusionary.
    expect(correctedLeg?.reviewStatus).toBe('needs_review');

    const formerCounterpart = await getTransaction(cardLeg);
    // Reverted to the plain M5 sign-based default: -5000 (Burmy convention,
    // positive = outflow) is an INFLOW -> income.
    expect(formerCounterpart?.transactionType).toBe('income');
    expect(formerCounterpart?.typeSource).toBe('default');
    expect(formerCounterpart?.counterpartTransactionId).toBeNull();
  });

  it('the freed leg’s review status is recomputed from ITS OWN category, not forced to needs_review', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const checkingId = await makeAccountId(owner, 'checking', 'Checking');
    const cardId = await makeAccountId(owner, 'credit_card', 'Card');
    const category = await categories.createCategory(owner, {
      name: 'Card Payments',
      slug: 'card-payments',
      kind: 'spending',
    });

    const checkingLeg = await seedTransaction({
      ownerId: owner,
      accountId: checkingId,
      amountCents: 5000,
      transactionType: 'credit_card_payment',
      typeSource: 'counterpart_match',
      reviewStatus: 'auto',
    });
    // The owner had ALSO manually put a category on the card leg at some
    // point, independent of its type classification.
    const cardLeg = await seedTransaction({
      ownerId: owner,
      accountId: cardId,
      amountCents: -5000,
      transactionType: 'credit_card_payment',
      typeSource: 'counterpart_match',
      reviewStatus: 'confirmed',
      categoryId: category.id,
      categorizationSource: 'manual',
    });
    await linkCounterparts(checkingLeg, cardLeg);

    await transactions.updateTransactionType(owner, checkingLeg, 'expense');

    const formerCounterpart = await getTransaction(cardLeg);
    expect(formerCounterpart?.categoryId).toBe(category.id);
    // Still confirmed — it has a category of its own, M6's reviewStatusFor
    // rule (category present -> confirmed/auto by source) applies on revert.
    expect(formerCounterpart?.reviewStatus).toBe('confirmed');
  });

  it('correcting a transaction with NO counterpart never touches an unrelated transaction', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const bystander = await seedTransaction({
      ownerId: owner,
      accountId,
      transactionType: 'expense',
      typeSource: 'default',
      reviewStatus: 'needs_review',
    });
    const target = await seedTransaction({ ownerId: owner, accountId, reviewStatus: 'needs_review' });

    await transactions.updateTransactionType(owner, target, 'transfer');

    const untouched = await getTransaction(bystander);
    expect(untouched?.transactionType).toBe('expense');
    expect(untouched?.typeSource).toBe('default');
    expect(untouched?.reviewStatus).toBe('needs_review');
  });

  it('rejects an id belonging to another owner, and touches nothing', async () => {
    const alice = await makeOwner('alice@burmy.test');
    const bob = await makeOwner('bob@burmy.test');
    const aliceChecking = await makeAccountId(alice, 'checking', 'Alice Checking');
    const aliceCard = await makeAccountId(alice, 'credit_card', 'Alice Card');

    const a = await seedTransaction({
      ownerId: alice,
      accountId: aliceChecking,
      transactionType: 'credit_card_payment',
      typeSource: 'counterpart_match',
    });
    const b = await seedTransaction({
      ownerId: alice,
      accountId: aliceCard,
      transactionType: 'credit_card_payment',
      typeSource: 'counterpart_match',
    });
    await linkCounterparts(a, b);

    await expect(transactions.updateTransactionType(bob, a, 'expense')).rejects.toThrow(errors.NotFoundError);

    const stillLinked = await getTransaction(a);
    expect(stillLinked?.counterpartTransactionId).toBe(b);
  });
});

describe('bulkUpdateCategory', () => {
  it('updates every selected id, confirms all of them, and writes no merchant memory', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, { name: 'Fees', slug: 'fees', kind: 'spending' });

    const a = await seedTransaction({ ownerId: owner, accountId, normalizedMerchant: 'FEE A' });
    const b = await seedTransaction({ ownerId: owner, accountId, normalizedMerchant: 'FEE B' });

    const updatedCount = await transactions.bulkUpdateCategory(owner, [a, b], category.id);
    expect(updatedCount).toBe(2);

    for (const id of [a, b]) {
      const txn = await getTransaction(id);
      expect(txn?.categoryId).toBe(category.id);
      expect(txn?.reviewStatus).toBe('confirmed');
    }

    const remembered = await merchantMemory.getMerchantMemoryForKeys(owner, ['FEE A', 'FEE B']);
    expect(remembered.size).toBe(0);
  });

  it('rememberMerchant: true upserts memory for every DISTINCT merchant in the selection, not once per row', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, { name: 'Fees', slug: 'fees-2', kind: 'spending' });

    // Two rows share ACMEFEE, one is a different merchant — three rows, two
    // distinct merchants, proving this dedupes rather than writing per row.
    const a = await seedTransaction({ ownerId: owner, accountId, normalizedMerchant: 'ACMEFEE' });
    const b = await seedTransaction({ ownerId: owner, accountId, normalizedMerchant: 'ACMEFEE' });
    const c = await seedTransaction({ ownerId: owner, accountId, normalizedMerchant: 'OTHERFEE' });

    const updatedCount = await transactions.bulkUpdateCategory(owner, [a, b, c], category.id, true);
    expect(updatedCount).toBe(3);

    const remembered = await merchantMemory.getMerchantMemoryForKeys(owner, ['ACMEFEE', 'OTHERFEE']);
    expect(remembered.size).toBe(2);
    expect(remembered.get('ACMEFEE')?.categoryId).toBe(category.id);
    expect(remembered.get('OTHERFEE')?.categoryId).toBe(category.id);
  });

  it('only updates ids owned by the caller', async () => {
    const alice = await makeOwner('alice@burmy.test');
    const bob = await makeOwner('bob@burmy.test');
    const aliceAccount = await makeAccountId(alice);
    const bobAccount = await makeAccountId(bob);
    const category = await categories.createCategory(bob, { name: 'Bob Cat', slug: 'bob-cat', kind: 'spending' });

    const aliceTxn = await seedTransaction({ ownerId: alice, accountId: aliceAccount });
    const bobTxn = await seedTransaction({ ownerId: bob, accountId: bobAccount });

    const updatedCount = await transactions.bulkUpdateCategory(bob, [aliceTxn, bobTxn], category.id);
    expect(updatedCount).toBe(1);

    expect((await getTransaction(aliceTxn))?.categoryId).toBeNull();
    expect((await getTransaction(bobTxn))?.categoryId).toBe(category.id);
  });

  it('is a no-op for an empty list', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const category = await categories.createCategory(owner, { name: 'Cat', slug: 'cat', kind: 'spending' });
    expect(await transactions.bulkUpdateCategory(owner, [], category.id)).toBe(0);
  });
});
