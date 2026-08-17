import { randomUUID } from 'node:crypto';

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { StageRowInput } from '@/server/db/finance/imports';
import { planStagedDecisions } from '@/server/finance/import/staging';
import { harness, resetDatabase } from './harness';

/**
 * The import pipeline's owner-scoped data-access layer, against real Postgres.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Two behaviours here are enforced by the DATABASE and by transaction
 * boundaries, not by TypeScript, which is why they are integration tests:
 *
 *   1. `commitImport()`'s re-reconciliation against the CURRENT committed count
 *      — the whole point is to observe a state that changed between staging
 *      and commit, which a mock cannot represent honestly.
 *   2. Cross-owner isolation on every mutation.
 *
 * Rows are staged by hand via `createStagedImport` rather than through
 * `parseStatementTolerant` + `uploadStatementAction` — this suite is about the
 * repository layer's own guarantees, and M4/M5's unit suites already cover
 * parsing and the pure reconciliation function these tests compose.
 * ─────────────────────────────────────────────────────────────────────────────
 */

type Accounts = typeof import('@/server/db/finance/accounts');
type Categories = typeof import('@/server/db/finance/categories');
type Imports = typeof import('@/server/db/finance/imports');
type Errors = typeof import('@/server/db/finance/errors');

let accounts: Accounts;
let categories: Categories;
let imports: Imports;
let errors: Errors;

beforeAll(async () => {
  await harness();
  [accounts, categories, imports, errors] = await Promise.all([
    import('@/server/db/finance/accounts'),
    import('@/server/db/finance/categories'),
    import('@/server/db/finance/imports'),
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
): Promise<string> {
  const account = await accounts.createAccount(ownerId, {
    name: `Test account ${randomUUID().slice(0, 8)}`,
    type,
    institution: null,
    lastFour: null,
  });
  return account.id;
}

/** A minimal, valid staged candidate row. Every field overridable. */
function makeCandidateRow(
  rowNumber: number,
  overrides: Partial<StageRowInput> = {},
): StageRowInput {
  return {
    rowNumber,
    transactionDate: '2026-05-01',
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
    // Placeholder — `stageWithReconciliation` below replaces this via the same
    // pure reconciliation `uploadStatementAction` uses.
    decision: 'exclude',
    duplicateOfTransactionId: null,
    parseError: null,
    ...overrides,
  };
}

/**
 * Stages rows the SAME way `uploadStatementAction` does: run the pure
 * `planStagedDecisions` against the current committed counts, then persist.
 * Rows carrying a `parseError` skip reconciliation entirely, exactly as a real
 * parse failure would.
 */
async function stageWithReconciliation(
  ownerId: string,
  accountId: string,
  rows: StageRowInput[],
  fileSha256: string = randomUUID().replace(/-/g, ''),
): Promise<string> {
  const candidateRows = rows.filter((row) => row.parseError === null);
  const failureRows = rows.filter((row) => row.parseError !== null);

  const keys = candidateRows.map((row) => row.dedupeKey).filter((key): key is string => key !== null);
  const committed = await imports.getCommittedCounts(ownerId, keys);
  const decisions = planStagedDecisions(
    candidateRows.map((row) => ({ rowNumber: row.rowNumber, dedupeKey: row.dedupeKey! })),
    committed,
  );
  const decisionByRow = new Map(decisions.map((decision) => [decision.rowNumber, decision]));

  const decided = candidateRows.map((row) => ({
    ...row,
    decision: decisionByRow.get(row.rowNumber)?.decision ?? 'exclude',
    duplicateOfTransactionId: decisionByRow.get(row.rowNumber)?.duplicateOfTransactionId ?? null,
  }));

  const { importId } = await imports.createStagedImport(ownerId, {
    accountId,
    originalFilename: 'statement.csv',
    fileSha256,
    adapter: 'boa-card',
    rows: [...decided, ...failureRows],
  });

  return importId;
}

async function insertCommittedTransaction(
  ownerId: string,
  accountId: string,
  options: {
    readonly dedupeKey: string;
    readonly amountCents?: number;
    readonly description?: string;
    readonly date?: string;
  },
): Promise<string> {
  const { sql } = await harness();
  const rows = await sql<{ id: string }[]>`
    insert into "finance_transactions"
      ("owner_id", "account_id", "transaction_date", "original_description",
       "amount_cents", "transaction_type", "dedupe_key")
    values
      (${ownerId}, ${accountId}, ${options.date ?? '2026-05-01'},
       ${options.description ?? 'PRIOR TXN'}, ${options.amountCents ?? 1000}, 'expense',
       ${options.dedupeKey})
    returning "id"
  `;
  return rows[0]!.id;
}

async function countTransactionsWithKey(key: string): Promise<number> {
  const { sql } = await harness();
  const rows = await sql<{ n: string }[]>`
    select count(*)::text as n from "finance_transactions" where "dedupe_key" = ${key}
  `;
  return Number(rows[0]?.n ?? '0');
}

describe('staging and reading back', () => {
  it('creates the import, its file, and every row in one shot', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);

    const importId = await stageWithReconciliation(owner, accountId, [
      makeCandidateRow(1, { dedupeKey: 'k1' }),
      makeCandidateRow(2, { dedupeKey: 'k2' }),
    ]);

    const summary = await imports.getImportForOwner(owner, importId);
    expect(summary.status).toBe('review');
    expect(summary.rowCount).toBe(2);
    expect(summary.accountId).toBe(accountId);

    const rows = await imports.getImportRows(owner, importId);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.decision)).toEqual(['include', 'include']);
  });

  it('captures a parse failure as a reviewable row, not a dropped one', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);

    const importId = await stageWithReconciliation(owner, accountId, [
      makeCandidateRow(1, { dedupeKey: 'k1' }),
      makeCandidateRow(2, {
        dedupeKey: null,
        transactionDate: null,
        amountCents: null,
        description: null,
        normalizedMerchant: null,
        merchantKey: null,
        parseError: 'line 2: impossible date "02/30/2026"',
      }),
    ]);

    const rows = await imports.getImportRows(owner, importId);
    const failed = rows.find((row) => row.parseError !== null);
    expect(failed).toBeDefined();
    expect(failed?.parseError).toMatch(/impossible date/);
    expect(failed?.amountCents).toBeNull();
  });
});

describe('Tier 2 reconciliation at staging', () => {
  it('excludes a row whose key is already fully covered by committed history', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    await insertCommittedTransaction(owner, accountId, { dedupeKey: 'already-there' });

    const importId = await stageWithReconciliation(owner, accountId, [
      makeCandidateRow(1, { dedupeKey: 'already-there' }),
    ]);

    const rows = await imports.getImportRows(owner, importId);
    expect(rows[0]?.decision).toBe('exclude');
    expect(rows[0]?.duplicateOfTransactionId).not.toBeNull();
  });

  it('re-uploading the same statement stages every row as a duplicate', async () => {
    // The idempotency property end to end: stage, commit, then stage the exact
    // same candidates again — everything must default to excluded.
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);

    const rows = [makeCandidateRow(1, { dedupeKey: 'repeat-key' })];
    const first = await stageWithReconciliation(owner, accountId, rows);
    await imports.commitImport(owner, first);

    const second = await stageWithReconciliation(owner, accountId, rows);
    const secondRows = await imports.getImportRows(owner, second);
    expect(secondRows[0]?.decision).toBe('exclude');

    const result = await imports.commitImport(owner, second);
    expect(result.importedCount).toBe(0);
    expect(await countTransactionsWithKey('repeat-key')).toBe(1);
  });
});

describe('commitImport', () => {
  it('writes the owner-picked category and marks the row confirmed', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const category = await categories.createCategory(owner, {
      name: 'Food',
      slug: 'food',
      kind: 'spending',
    });

    const importId = await stageWithReconciliation(owner, accountId, [
      makeCandidateRow(1, { dedupeKey: 'cat-key' }),
    ]);
    const rows = await imports.getImportRows(owner, importId);
    await imports.updateRowDecision(owner, importId, rows[0]!.id, { categoryId: category.id });

    await imports.commitImport(owner, importId);

    const { sql } = await harness();
    const txns = await sql<{ category_id: string | null; review_status: string }[]>`
      select "category_id", "review_status" from "finance_transactions" where "dedupe_key" = 'cat-key'
    `;
    expect(txns[0]?.category_id).toBe(category.id);
    expect(txns[0]?.review_status).toBe('confirmed');
  });

  it('leaves an uncategorized row needs_review, not blocked', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const importId = await stageWithReconciliation(owner, accountId, [
      makeCandidateRow(1, { dedupeKey: 'no-cat' }),
    ]);

    await imports.commitImport(owner, importId);

    const { sql } = await harness();
    const txns = await sql<{ category_id: string | null; review_status: string }[]>`
      select "category_id", "review_status" from "finance_transactions" where "dedupe_key" = 'no-cat'
    `;
    expect(txns[0]?.category_id).toBeNull();
    expect(txns[0]?.review_status).toBe('needs_review');
  });

  it('defaults transaction type by sign, never an exclusionary type', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const importId = await stageWithReconciliation(owner, accountId, [
      makeCandidateRow(1, { dedupeKey: 'outflow-key', amountCents: 2500 }),
      makeCandidateRow(2, { dedupeKey: 'inflow-key', amountCents: -2500 }),
    ]);

    await imports.commitImport(owner, importId);

    const { sql } = await harness();
    const txns = await sql<{ dedupe_key: string; transaction_type: string }[]>`
      select "dedupe_key", "transaction_type" from "finance_transactions"
      where "dedupe_key" in ('outflow-key', 'inflow-key')
    `;
    const byKey = Object.fromEntries(txns.map((row) => [row.dedupe_key, row.transaction_type]));
    expect(byKey['outflow-key']).toBe('expense');
    expect(byKey['inflow-key']).toBe('income');
  });

  it('refuses to commit twice', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const importId = await stageWithReconciliation(owner, accountId, [
      makeCandidateRow(1, { dedupeKey: 'once-key' }),
    ]);

    await imports.commitImport(owner, importId);
    await expect(imports.commitImport(owner, importId)).rejects.toThrow(errors.ImportNotReviewableError);
    expect(await countTransactionsWithKey('once-key')).toBe(1);
  });

  describe('the race check', () => {
    it('demotes a NATURAL include when a concurrent commit already claimed the key', async () => {
      const owner = await makeOwner('owner@burmy.test');
      const accountId = await makeAccountId(owner);
      const key = 'race-natural';

      const importId = await stageWithReconciliation(owner, accountId, [
        makeCandidateRow(1, { dedupeKey: key }),
      ]);
      const staged = await imports.getImportRows(owner, importId);
      expect(staged[0]?.decision).toBe('include');
      expect(staged[0]?.decisionOverridden).toBe(false);

      // Simulate a second import committing the same key FIRST.
      await insertCommittedTransaction(owner, accountId, { dedupeKey: key });

      const result = await imports.commitImport(owner, importId);

      expect(result.importedCount).toBe(0);
      expect(result.demotedByRaceCount).toBe(1);

      const after = await imports.getImportRows(owner, importId);
      expect(after[0]?.decision).toBe('exclude');
      expect(await countTransactionsWithKey(key)).toBe(1);
    });

    it('honours an explicit owner override even when a concurrent commit claimed the key', async () => {
      const owner = await makeOwner('owner@burmy.test');
      const accountId = await makeAccountId(owner);
      const key = 'race-override';

      // One already committed, so this stages as a duplicate by default.
      await insertCommittedTransaction(owner, accountId, { dedupeKey: key });
      const importId = await stageWithReconciliation(owner, accountId, [
        makeCandidateRow(1, { dedupeKey: key }),
      ]);

      const staged = await imports.getImportRows(owner, importId);
      expect(staged[0]?.decision).toBe('exclude');

      // The owner reviews it and recognises a genuine second purchase.
      await imports.updateRowDecision(owner, importId, staged[0]!.id, { decision: 'include' });

      // Another concurrent commit claims the key again before this one commits.
      await insertCommittedTransaction(owner, accountId, { dedupeKey: key });

      const result = await imports.commitImport(owner, importId);

      // Unconditionally honoured — not capped by the now-higher fresh count.
      expect(result.importedCount).toBe(1);
      expect(result.demotedByRaceCount).toBe(0);
      expect(await countTransactionsWithKey(key)).toBe(3);
    });
  });
});

describe('discardImport', () => {
  it('marks the import discarded and drops it from the in-progress list', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const importId = await stageWithReconciliation(owner, accountId, [
      makeCandidateRow(1, { dedupeKey: 'discard-key' }),
    ]);

    await imports.discardImport(owner, importId);

    const summary = await imports.getImportForOwner(owner, importId);
    expect(summary.status).toBe('discarded');
    expect((await imports.listInProgressImports(owner)).map((i) => i.id)).not.toContain(importId);
  });

  it('cannot discard twice', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const importId = await stageWithReconciliation(owner, accountId, [
      makeCandidateRow(1, { dedupeKey: 'discard-key-2' }),
    ]);

    await imports.discardImport(owner, importId);
    await expect(imports.discardImport(owner, importId)).rejects.toThrow(errors.ImportNotReviewableError);
  });
});

describe('updateRowDecision', () => {
  it('sets decisionOverridden only when `decision` is explicitly passed', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const importId = await stageWithReconciliation(owner, accountId, [
      makeCandidateRow(1, { dedupeKey: 'override-key' }),
    ]);
    const rows = await imports.getImportRows(owner, importId);

    await imports.updateRowDecision(owner, importId, rows[0]!.id, { categoryId: null });
    expect((await imports.getImportRows(owner, importId))[0]?.decisionOverridden).toBe(false);

    await imports.updateRowDecision(owner, importId, rows[0]!.id, { decision: 'exclude' });
    expect((await imports.getImportRows(owner, importId))[0]?.decisionOverridden).toBe(true);
  });

  it('refuses to mark a FAILED row Include — nothing valid to import', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const importId = await stageWithReconciliation(owner, accountId, [
      makeCandidateRow(1, {
        dedupeKey: null,
        transactionDate: null,
        amountCents: null,
        description: null,
        parseError: 'bad row',
      }),
    ]);
    const rows = await imports.getImportRows(owner, importId);

    await expect(
      imports.updateRowDecision(owner, importId, rows[0]!.id, { decision: 'include' }),
    ).rejects.toThrow(errors.NotFoundError);
  });

  it('refuses to edit a row once the import has left review', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const importId = await stageWithReconciliation(owner, accountId, [
      makeCandidateRow(1, { dedupeKey: 'closed-key' }),
    ]);
    const rows = await imports.getImportRows(owner, importId);
    await imports.discardImport(owner, importId);

    await expect(
      imports.updateRowDecision(owner, importId, rows[0]!.id, { decision: 'exclude' }),
    ).rejects.toThrow(errors.ImportNotReviewableError);
  });
});

describe('findPriorFileUpload — status-aware messaging', () => {
  it('is null when the file has never been seen', async () => {
    const owner = await makeOwner('owner@burmy.test');
    expect(await imports.findPriorFileUpload(owner, 'never-seen')).toBeNull();
  });

  it('reports `review` before commit — never called "already imported"', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const importId = await stageWithReconciliation(
      owner,
      accountId,
      [makeCandidateRow(1, { dedupeKey: 'hash-review' })],
      'hash-review',
    );

    const prior = await imports.findPriorFileUpload(owner, 'hash-review');
    expect(prior?.importId).toBe(importId);
    expect(prior?.status).toBe('review');
    expect(prior?.committedAt).toBeNull();
  });

  it('reports `committed`, with a timestamp, only after an actual commit', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const importId = await stageWithReconciliation(
      owner,
      accountId,
      [makeCandidateRow(1, { dedupeKey: 'hash-committed' })],
      'hash-committed',
    );
    await imports.commitImport(owner, importId);

    const prior = await imports.findPriorFileUpload(owner, 'hash-committed');
    expect(prior?.status).toBe('committed');
    expect(prior?.committedAt).not.toBeNull();
  });

  it('reports `discarded` — never "already imported"', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const importId = await stageWithReconciliation(
      owner,
      accountId,
      [makeCandidateRow(1, { dedupeKey: 'hash-discarded' })],
      'hash-discarded',
    );
    await imports.discardImport(owner, importId);

    const prior = await imports.findPriorFileUpload(owner, 'hash-discarded');
    expect(prior?.status).toBe('discarded');
  });

  it('excludes the import itself when asked to', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const accountId = await makeAccountId(owner);
    const importId = await stageWithReconciliation(
      owner,
      accountId,
      [makeCandidateRow(1, { dedupeKey: 'hash-self' })],
      'hash-self',
    );

    expect(await imports.findPriorFileUpload(owner, 'hash-self', importId)).toBeNull();
  });
});

describe('cross-owner isolation', () => {
  it('cannot read, edit, commit or discard another owner import', async () => {
    const alice = await makeOwner('alice@burmy.test');
    const bob = await makeOwner('bob@burmy.test');
    const aliceAccount = await makeAccountId(alice);

    const importId = await stageWithReconciliation(alice, aliceAccount, [
      makeCandidateRow(1, { dedupeKey: 'iso-key' }),
    ]);

    await expect(imports.getImportForOwner(bob, importId)).rejects.toThrow(errors.NotFoundError);
    await expect(imports.getImportRows(bob, importId)).rejects.toThrow(errors.NotFoundError);
    await expect(imports.commitImport(bob, importId)).rejects.toThrow(errors.NotFoundError);
    await expect(imports.discardImport(bob, importId)).rejects.toThrow(errors.NotFoundError);

    const aliceRows = await imports.getImportRows(alice, importId);
    await expect(
      imports.updateRowDecision(bob, importId, aliceRows[0]!.id, { decision: 'exclude' }),
    ).rejects.toThrow(errors.NotFoundError);

    expect(await imports.listInProgressImports(bob)).toEqual([]);
    // Alice's row is untouched by Bob's attempts.
    expect((await imports.getImportRows(alice, importId))[0]?.decision).toBe('include');
  });
});
