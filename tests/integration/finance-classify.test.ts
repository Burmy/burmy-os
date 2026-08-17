import { randomUUID } from 'node:crypto';

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { StageRowInput } from '@/server/db/finance/imports';
import { planStagedDecisions } from '@/server/finance/import/staging';
import { harness, resetDatabase } from './harness';

/**
 * M6's classification layer, against real Postgres: merchant memory and
 * counterpart matching.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why integration tests, not unit tests, for this
 *
 * The pure decision logic (`findQualifyingCounterpart`, `reviewStatusFor`) is
 * already covered in tests/unit/. What can ONLY be proven against a real
 * database is `commitImport()`'s own composition of it: the upsert-on-conflict
 * for merchant memory, the retroactive UPDATE of an ALREADY-COMMITTED
 * counterpart from a prior import (in either import order), and — most
 * importantly — that `type_source = 'default'` genuinely gates every write,
 * so a manually-confirmed transaction (what M7 will eventually produce) is
 * provably never touched by this milestone's automation.
 * ─────────────────────────────────────────────────────────────────────────────
 */

type Accounts = typeof import('@/server/db/finance/accounts');
type Categories = typeof import('@/server/db/finance/categories');
type Imports = typeof import('@/server/db/finance/imports');
type MerchantMemory = typeof import('@/server/db/finance/merchant-memory');

let accounts: Accounts;
let categories: Categories;
let imports: Imports;
let merchantMemory: MerchantMemory;

beforeAll(async () => {
  await harness();
  [accounts, categories, imports, merchantMemory] = await Promise.all([
    import('@/server/db/finance/accounts'),
    import('@/server/db/finance/categories'),
    import('@/server/db/finance/imports'),
    import('@/server/db/finance/merchant-memory'),
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

function makeCandidateRow(rowNumber: number, overrides: Partial<StageRowInput> = {}): StageRowInput {
  return {
    rowNumber,
    transactionDate: '2026-05-15',
    postedDate: null,
    description: `ROW ${rowNumber}`,
    amountCents: 1000,
    detectedDirection: 'outflow',
    sourceCategory: null,
    sourceTransactionId: null,
    normalizedMerchant: `MERCHANT ${rowNumber}`,
    merchantKey: `MERCHANT${rowNumber}`,
    dedupeKey: `key-${rowNumber}-${randomUUID()}`,
    dedupeKeyVersion: 1,
    decision: 'exclude',
    duplicateOfTransactionId: null,
    parseError: null,
    suggestedCategoryId: null,
    categorizationSource: null,
    ...overrides,
  };
}

/** Stages rows exactly as given — no Tier 2 recomputation, since these tests are not about duplicates. */
async function stageRows(
  ownerId: string,
  accountId: string,
  rows: StageRowInput[],
  fileSha256: string = randomUUID().replace(/-/g, ''),
): Promise<string> {
  const decided = rows.map((row) => ({ ...row, decision: 'include' as const }));
  const { importId } = await imports.createStagedImport(ownerId, {
    accountId,
    originalFilename: 'statement.csv',
    fileSha256,
    adapter: 'boa-card',
    rows: decided,
  });
  return importId;
}

/** Uses `planStagedDecisions` for callers that DO care about Tier 2 (the re-upload/idempotency tests). */
async function stageWithReconciliation(
  ownerId: string,
  accountId: string,
  rows: StageRowInput[],
  fileSha256: string = randomUUID().replace(/-/g, ''),
): Promise<string> {
  const keys = rows.map((row) => row.dedupeKey).filter((key): key is string => key !== null);
  const committed = await imports.getCommittedCounts(ownerId, keys);
  const decisions = planStagedDecisions(
    rows.map((row) => ({ rowNumber: row.rowNumber, dedupeKey: row.dedupeKey! })),
    committed,
  );
  const decisionByRow = new Map(decisions.map((decision) => [decision.rowNumber, decision]));
  const decided = rows.map((row) => ({
    ...row,
    decision: decisionByRow.get(row.rowNumber)?.decision ?? 'exclude',
    duplicateOfTransactionId: decisionByRow.get(row.rowNumber)?.duplicateOfTransactionId ?? null,
  }));

  const { importId } = await imports.createStagedImport(ownerId, {
    accountId,
    originalFilename: 'statement.csv',
    fileSha256,
    adapter: 'boa-card',
    rows: decided,
  });
  return importId;
}

async function getTransactionByDedupeKey(dedupeKey: string): Promise<{
  readonly id: string;
  readonly transactionType: string;
  readonly typeSource: string;
  readonly counterpartTransactionId: string | null;
  readonly reviewStatus: string;
  readonly categoryId: string | null;
} | null> {
  const { sql } = await harness();
  const rows = await sql<
    {
      id: string;
      transaction_type: string;
      type_source: string;
      counterpart_transaction_id: string | null;
      review_status: string;
      category_id: string | null;
    }[]
  >`
    select "id", "transaction_type", "type_source", "counterpart_transaction_id", "review_status", "category_id"
    from "finance_transactions" where "dedupe_key" = ${dedupeKey}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    transactionType: row.transaction_type,
    typeSource: row.type_source,
    counterpartTransactionId: row.counterpart_transaction_id,
    reviewStatus: row.review_status,
    categoryId: row.category_id,
  };
}

async function setTypeSource(dedupeKey: string, typeSource: string): Promise<void> {
  const { sql } = await harness();
  await sql`update "finance_transactions" set "type_source" = ${typeSource} where "dedupe_key" = ${dedupeKey}`;
}

describe('merchant memory', () => {
  it('is empty for a merchant never confirmed before', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const found = await merchantMemory.getMerchantMemoryForKeys(owner, ['NOTSEEN']);
    expect(found.size).toBe(0);
  });

  it('a committed category is remembered, and pre-fills staging for the same merchant next time', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, {
      name: 'Gym',
      slug: 'gym',
      kind: 'spending',
    });

    const first = await stageRows(owner, accountId, [
      makeCandidateRow(1, {
        dedupeKey: 'gym-1',
        merchantKey: 'PLANETFITNESS',
        suggestedCategoryId: category.id,
        categorizationSource: 'manual',
      }),
    ]);
    await imports.commitImport(owner, first);

    const remembered = await merchantMemory.getMerchantMemoryForKeys(owner, ['PLANETFITNESS']);
    expect(remembered.get('PLANETFITNESS')).toEqual({ categoryId: category.id, confirmedCount: 1 });

    // A second, later statement carrying the SAME merchant: staging would
    // look this up and pre-fill it — proven directly here.
    const second = await merchantMemory.getMerchantMemoryForKeys(owner, ['PLANETFITNESS']);
    expect(second.get('PLANETFITNESS')?.categoryId).toBe(category.id);
  });

  it('a row committed with the merchant-memory suggestion, untouched, is reviewStatus auto', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, {
      name: 'Car Payments',
      slug: 'car-payments',
      kind: 'spending',
    });

    const importId = await stageRows(owner, accountId, [
      makeCandidateRow(1, {
        dedupeKey: 'memory-auto',
        merchantKey: 'CAPITALONEAUTO',
        suggestedCategoryId: category.id,
        categorizationSource: 'merchant_memory',
      }),
    ]);
    await imports.commitImport(owner, importId);

    const txn = await getTransactionByDedupeKey('memory-auto');
    expect(txn?.categoryId).toBe(category.id);
    expect(txn?.reviewStatus).toBe('auto');
  });

  it('confirmedCount increments on repeat confirmation, refreshing the memory', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, {
      name: 'Income',
      slug: 'income',
      kind: 'income',
    });

    for (const n of [1, 2, 3]) {
      const importId = await stageRows(owner, accountId, [
        makeCandidateRow(1, {
          dedupeKey: `payroll-${n}`,
          merchantKey: 'NORTHWINDTECHNO',
          amountCents: -200_000,
          suggestedCategoryId: category.id,
          categorizationSource: n === 1 ? 'manual' : 'merchant_memory',
        }),
      ]);
      await imports.commitImport(owner, importId);
    }

    const remembered = await merchantMemory.getMerchantMemoryForKeys(owner, ['NORTHWINDTECHNO']);
    expect(remembered.get('NORTHWINDTECHNO')?.confirmedCount).toBe(3);
  });

  it('an owner override replaces the remembered category going forward', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const gas = await categories.createCategory(owner, { name: 'Gas', slug: 'gas', kind: 'spending' });
    const auto = await categories.createCategory(owner, { name: 'Auto', slug: 'auto', kind: 'spending' });

    const first = await stageRows(owner, accountId, [
      makeCandidateRow(1, {
        dedupeKey: 'override-1',
        merchantKey: 'SHELLSTATION',
        suggestedCategoryId: gas.id,
        categorizationSource: 'manual',
      }),
    ]);
    await imports.commitImport(owner, first);

    // Next month, staging would suggest Gas — the owner instead picks Auto.
    const second = await stageRows(owner, accountId, [
      makeCandidateRow(1, {
        dedupeKey: 'override-2',
        merchantKey: 'SHELLSTATION',
        suggestedCategoryId: auto.id,
        categorizationSource: 'manual',
      }),
    ]);
    await imports.commitImport(owner, second);

    const remembered = await merchantMemory.getMerchantMemoryForKeys(owner, ['SHELLSTATION']);
    expect(remembered.get('SHELLSTATION')?.categoryId).toBe(auto.id);
  });
});

describe('counterpart matching — credit card payments', () => {
  it('links both legs when checking commits FIRST, then the card statement', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const checkingId = await makeAccountId(owner, 'checking', 'Checking');
    const cardId = await makeAccountId(owner, 'credit_card', 'Card');

    const checkingImport = await stageRows(owner, checkingId, [
      makeCandidateRow(1, {
        dedupeKey: 'chk-leg',
        description: 'Online Banking payment to CRD 9903 Confirmation# 4p9dnrwz6',
        amountCents: 8815,
        transactionDate: '2026-05-14',
      }),
    ]);
    await imports.commitImport(owner, checkingImport);

    const cardImport = await stageRows(owner, cardId, [
      makeCandidateRow(1, {
        dedupeKey: 'card-leg',
        description: 'PAYMENT FROM CHK 2288 CONF#4p9dnrwz6',
        amountCents: -8815,
        transactionDate: '2026-05-19',
      }),
    ]);
    const result = await imports.commitImport(owner, cardImport);

    expect(result.autoClassifiedCount).toBe(1);

    const checkingTxn = await getTransactionByDedupeKey('chk-leg');
    const cardTxn = await getTransactionByDedupeKey('card-leg');

    expect(checkingTxn?.transactionType).toBe('credit_card_payment');
    expect(checkingTxn?.typeSource).toBe('counterpart_match');
    expect(checkingTxn?.reviewStatus).toBe('auto');
    expect(checkingTxn?.counterpartTransactionId).toBe(cardTxn?.id);

    expect(cardTxn?.transactionType).toBe('credit_card_payment');
    expect(cardTxn?.typeSource).toBe('counterpart_match');
    expect(cardTxn?.counterpartTransactionId).toBe(checkingTxn?.id);
  });

  it('links both legs in the REVERSE order — card statement first, checking second', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const checkingId = await makeAccountId(owner, 'checking', 'Checking');
    const cardId = await makeAccountId(owner, 'credit_card', 'Card');

    const cardImport = await stageRows(owner, cardId, [
      makeCandidateRow(1, {
        dedupeKey: 'card-leg-r',
        description: 'PAYMENT FROM CHK 2288 CONF#reversed1',
        amountCents: -8815,
        transactionDate: '2026-05-19',
      }),
    ]);
    await imports.commitImport(owner, cardImport);

    const checkingImport = await stageRows(owner, checkingId, [
      makeCandidateRow(1, {
        dedupeKey: 'chk-leg-r',
        description: 'Online Banking payment to CRD 9903 Confirmation# reversed1',
        amountCents: 8815,
        transactionDate: '2026-05-14',
      }),
    ]);
    await imports.commitImport(owner, checkingImport);

    const checkingTxn = await getTransactionByDedupeKey('chk-leg-r');
    const cardTxn = await getTransactionByDedupeKey('card-leg-r');

    expect(checkingTxn?.transactionType).toBe('credit_card_payment');
    expect(cardTxn?.transactionType).toBe('credit_card_payment');
    expect(cardTxn?.typeSource).toBe('counterpart_match');
    expect(cardTxn?.counterpartTransactionId).toBe(checkingTxn?.id);
  });

  it('does not match across owners, even with identical description text', async () => {
    const alice = await makeOwner('alice@burmy.test');
    const bob = await makeOwner('bob@burmy.test');
    const aliceChecking = await makeAccountId(alice, 'checking', 'Alice Checking');
    const bobCard = await makeAccountId(bob, 'credit_card', 'Bob Card');

    const aliceImport = await stageRows(alice, aliceChecking, [
      makeCandidateRow(1, {
        dedupeKey: 'alice-leg',
        description: 'Online Banking payment to CRD 9903 Confirmation# crossowner',
        amountCents: 5000,
        transactionDate: '2026-05-14',
      }),
    ]);
    await imports.commitImport(alice, aliceImport);

    const bobImport = await stageRows(bob, bobCard, [
      makeCandidateRow(1, {
        dedupeKey: 'bob-leg',
        description: 'PAYMENT FROM CHK 2288 CONF#crossowner',
        amountCents: -5000,
        transactionDate: '2026-05-19',
      }),
    ]);
    await imports.commitImport(bob, bobImport);

    const bobTxn = await getTransactionByDedupeKey('bob-leg');
    expect(bobTxn?.typeSource).toBe('default');
    expect(bobTxn?.transactionType).not.toBe('credit_card_payment');
  });
});

describe('counterpart matching — transfers (non-card)', () => {
  it('labels both legs transfer when neither account is a credit card', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const checkingId = await makeAccountId(owner, 'checking', 'Checking');
    const savingsId = await makeAccountId(owner, 'savings', 'Savings');

    const checkingImport = await stageRows(owner, checkingId, [
      makeCandidateRow(1, {
        dedupeKey: 'transfer-out',
        description: 'Online Banking transfer to SAV 4412 Confirmation# 4029518337',
        amountCents: 54025,
        transactionDate: '2026-05-14',
      }),
    ]);
    await imports.commitImport(owner, checkingImport);

    const savingsImport = await stageRows(owner, savingsId, [
      makeCandidateRow(1, {
        dedupeKey: 'transfer-in',
        description: 'Online Banking transfer from CHK 2288 Confirmation# 4029518337',
        amountCents: -54025,
        transactionDate: '2026-05-14',
      }),
    ]);
    await imports.commitImport(owner, savingsImport);

    const outTxn = await getTransactionByDedupeKey('transfer-out');
    const inTxn = await getTransactionByDedupeKey('transfer-in');

    expect(outTxn?.transactionType).toBe('transfer');
    expect(inTxn?.transactionType).toBe('transfer');
    expect(inTxn?.typeSource).toBe('counterpart_match');
  });
});

describe('no match stays default — never a guess', () => {
  it('a token with no counterpart anywhere stays the M5 sign-based default', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);

    const importId = await stageRows(owner, accountId, [
      makeCandidateRow(1, {
        dedupeKey: 'unmatched',
        description: 'SUMMIT CREDIT CRD DES:AUTOPAY ID:000000000417338',
        amountCents: 31108,
        transactionDate: '2026-05-27',
      }),
    ]);
    const result = await imports.commitImport(owner, importId);

    expect(result.autoClassifiedCount).toBe(0);
    const txn = await getTransactionByDedupeKey('unmatched');
    expect(txn?.transactionType).toBe('expense');
    expect(txn?.typeSource).toBe('default');
  });

  it('ambiguous — two equally qualifying candidates — classifies neither', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const checkingId = await makeAccountId(owner, 'checking', 'Checking');
    const cardId = await makeAccountId(owner, 'credit_card', 'Card');

    // Two DIFFERENT committed card-side transactions that both happen to
    // share the same token and the same amount — contrived, but exactly the
    // scenario "exactly one candidate" exists to refuse.
    await stageRows(owner, cardId, [
      makeCandidateRow(1, {
        dedupeKey: 'ambiguous-a',
        description: 'PAYMENT FROM CHK 2288 CONF#ambiguous',
        amountCents: -4000,
        transactionDate: '2026-05-19',
      }),
    ]).then((id) => imports.commitImport(owner, id));

    await stageRows(
      owner,
      cardId,
      [
        makeCandidateRow(1, {
          dedupeKey: 'ambiguous-b',
          description: 'PAYMENT FROM CHK 2288 CONF#ambiguous',
          amountCents: -4000,
          transactionDate: '2026-05-20',
        }),
      ],
      randomUUID().replace(/-/g, ''),
    ).then((id) => imports.commitImport(owner, id));

    const checkingImport = await stageRows(owner, checkingId, [
      makeCandidateRow(1, {
        dedupeKey: 'ambiguous-new',
        description: 'Online Banking payment to CRD 9903 Confirmation# ambiguous',
        amountCents: 4000,
        transactionDate: '2026-05-21',
      }),
    ]);
    const result = await imports.commitImport(owner, checkingImport);

    expect(result.autoClassifiedCount).toBe(0);
    const newTxn = await getTransactionByDedupeKey('ambiguous-new');
    expect(newTxn?.typeSource).toBe('default');

    // Neither pre-existing candidate was touched either.
    const a = await getTransactionByDedupeKey('ambiguous-a');
    const b = await getTransactionByDedupeKey('ambiguous-b');
    expect(a?.typeSource).toBe('default');
    expect(b?.typeSource).toBe('default');
  });
});

describe('automatic classification never overwrites a manual decision', () => {
  it('skips a candidate whose type_source is already non-default, and leaves the new row unmatched too', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const checkingId = await makeAccountId(owner, 'checking', 'Checking');
    const cardId = await makeAccountId(owner, 'credit_card', 'Card');

    const cardImport = await stageRows(owner, cardId, [
      makeCandidateRow(1, {
        dedupeKey: 'protected-leg',
        description: 'PAYMENT FROM CHK 2288 CONF#protected',
        amountCents: -2500,
        transactionDate: '2026-05-19',
      }),
    ]);
    await imports.commitImport(owner, cardImport);

    // Simulate what M7's (future) manual confirmation UI will do: the owner
    // decided this is NOT a card payment after all, and locked it in.
    await setTypeSource('protected-leg', 'manual_confirmation');

    const checkingImport = await stageRows(owner, checkingId, [
      makeCandidateRow(1, {
        dedupeKey: 'would-have-matched',
        description: 'Online Banking payment to CRD 9903 Confirmation# protected',
        amountCents: 2500,
        transactionDate: '2026-05-14',
      }),
    ]);
    const result = await imports.commitImport(owner, checkingImport);

    expect(result.autoClassifiedCount).toBe(0);

    const protectedLeg = await getTransactionByDedupeKey('protected-leg');
    expect(protectedLeg?.typeSource).toBe('manual_confirmation');
    expect(protectedLeg?.counterpartTransactionId).toBeNull();

    const newLeg = await getTransactionByDedupeKey('would-have-matched');
    expect(newLeg?.typeSource).toBe('default');
    expect(newLeg?.transactionType).toBe('expense');
  });
});

describe('re-upload idempotency still holds with classification in the mix', () => {
  it('re-staging the same statement stays a duplicate and commits nothing new', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const rows = [makeCandidateRow(1, { dedupeKey: 'idempotent-key' })];

    const first = await stageWithReconciliation(owner, accountId, rows);
    await imports.commitImport(owner, first);

    const second = await stageWithReconciliation(owner, accountId, rows);
    const result = await imports.commitImport(owner, second);

    expect(result.importedCount).toBe(0);
  });
});
