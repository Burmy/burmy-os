import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { harness, resetDatabase } from './harness';

/**
 * The owner-scoped finance data-access layer, against a real PostgreSQL 18.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THESE ARE INTEGRATION TESTS AND NOT UNIT TESTS
 *
 * Almost every behaviour here is enforced by the DATABASE, not by TypeScript:
 * the partial unique index on `(owner_id, lower(name)) WHERE archived_at IS NULL`,
 * the `ON DELETE SET NULL` on `category_id`, the transaction around reordering.
 * A mocked database would assert that the mock behaves the way I assumed the real
 * one does, which is the assumption most worth testing.
 *
 * Plan §14 asks for cross-owner isolation to be proven "by integration tests
 * asserting cross-owner isolation" rather than by a lint rule. That is the
 * `cross-owner isolation` block at the bottom.
 * ─────────────────────────────────────────────────────────────────────────────
 */

type Accounts = typeof import('@/server/db/finance/accounts');
type Categories = typeof import('@/server/db/finance/categories');
type Errors = typeof import('@/server/db/finance/errors');

let accounts: Accounts;
let categories: Categories;
let errors: Errors;

beforeAll(async () => {
  await harness();
  [accounts, categories, errors] = await Promise.all([
    import('@/server/db/finance/accounts'),
    import('@/server/db/finance/categories'),
    import('@/server/db/finance/errors'),
  ]);
});

beforeEach(async () => {
  await resetDatabase();
});

/** Create a user row directly — this suite is about finance data, not auth. */
async function makeOwner(email: string): Promise<string> {
  const { sql } = await harness();
  const { randomUUID } = await import('node:crypto');
  const id = randomUUID();

  await sql`
    insert into "user" ("id", "name", "email", "email_verified")
    values (${id}, ${email}, ${email}, true)
  `;

  return id;
}

describe('accounts', () => {
  it('creates and lists in sort order', async () => {
    const owner = await makeOwner('owner@burmy.test');

    await accounts.createAccount(owner, {
      name: 'BoA Checking',
      type: 'checking',
      institution: 'Bank of America',
      lastFour: '1234',
    });
    await accounts.createAccount(owner, {
      name: 'BoA Card',
      type: 'credit_card',
      institution: 'Bank of America',
      lastFour: null,
    });

    const list = await accounts.listAccounts(owner);
    expect(list.map((a) => a.name)).toEqual(['BoA Checking', 'BoA Card']);
    expect(list[0]?.lastFour).toBe('1234');
    expect(list[1]?.lastFour).toBeNull();
  });

  it('rejects a duplicate name case-insensitively', async () => {
    const owner = await makeOwner('owner@burmy.test');
    await accounts.createAccount(owner, {
      name: 'BoA Checking',
      type: 'checking',
      institution: null,
      lastFour: null,
    });

    await expect(
      accounts.createAccount(owner, {
        name: 'boa checking',
        type: 'savings',
        institution: null,
        lastFour: null,
      }),
    ).rejects.toThrow(errors.DuplicateNameError);
  });

  it('lets an account keep its own name when edited', async () => {
    // The duplicate check must exclude the row being updated, or renaming
    // "BoA Checking" to "BoA Checking " (say, fixing the institution) would fail.
    const owner = await makeOwner('owner@burmy.test');
    const account = await accounts.createAccount(owner, {
      name: 'BoA Checking',
      type: 'checking',
      institution: null,
      lastFour: null,
    });

    const updated = await accounts.updateAccount(owner, account.id, {
      name: 'BoA Checking',
      type: 'checking',
      institution: 'Bank of America',
      lastFour: '9999',
    });

    expect(updated.institution).toBe('Bank of America');
    expect(updated.lastFour).toBe('9999');
  });

  it('deactivates rather than deleting, and can reactivate', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const account = await accounts.createAccount(owner, {
      name: 'Old Card',
      type: 'credit_card',
      institution: null,
      lastFour: null,
    });

    const off = await accounts.setAccountActive(owner, account.id, false);
    expect(off.isActive).toBe(false);
    // Still present — history must stay attributable.
    expect(await accounts.listAccounts(owner)).toHaveLength(1);

    const on = await accounts.setAccountActive(owner, account.id, true);
    expect(on.isActive).toBe(true);
  });

  it('reports a missing account as not found', async () => {
    const owner = await makeOwner('owner@burmy.test');
    await expect(
      accounts.getAccount(owner, '00000000-0000-4000-8000-000000000000'),
    ).rejects.toThrow(errors.NotFoundError);
  });
});

describe('categories', () => {
  it('creates with a dense sort order', async () => {
    const owner = await makeOwner('owner@burmy.test');

    for (const name of ['Mortgage', 'Gas', 'Food']) {
      await categories.createCategory(owner, {
        name,
        slug: name.toLowerCase(),
        kind: 'spending',
      });
    }

    const list = await categories.listCategories(owner);
    expect(list.map((c) => c.name)).toEqual(['Mortgage', 'Gas', 'Food']);
    expect(list.map((c) => c.sortOrder)).toEqual([0, 1, 2]);
  });

  it('rejects two LIVE categories with the same name, case-insensitively', async () => {
    const owner = await makeOwner('owner@burmy.test');
    await categories.createCategory(owner, { name: 'Travel', slug: 'travel', kind: 'spending' });

    await expect(
      categories.createCategory(owner, { name: 'travel', slug: 'travel', kind: 'spending' }),
    ).rejects.toThrow(errors.DuplicateNameError);
  });

  it('lets the DATABASE decide uniqueness, not a pre-check', async () => {
    // Two concurrent creates of the same name: the partial unique index must
    // reject one. A read-then-write pre-check would let both through.
    const owner = await makeOwner('owner@burmy.test');

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        categories.createCategory(owner, {
          name: 'Groceries',
          slug: 'groceries',
          kind: 'spending',
        }),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await categories.listCategories(owner)).toHaveLength(1);
  });

  it('frees the name once archived, and archived rows are hidden by default', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const first = await categories.createCategory(owner, {
      name: 'Travel',
      slug: 'travel',
      kind: 'spending',
    });

    await categories.archiveCategory(owner, first.id);

    // Hidden from pickers...
    expect(await categories.listCategories(owner)).toHaveLength(0);
    // ...but still there.
    expect(await categories.listCategories(owner, { includeArchived: true })).toHaveLength(1);

    // And the name is reusable, which is the whole point of the partial index.
    const second = await categories.createCategory(owner, {
      name: 'Travel',
      slug: 'travel',
      kind: 'spending',
    });
    expect(second.id).not.toBe(first.id);
  });

  it('ARCHIVING PRESERVES HISTORY — a transaction keeps pointing at it', async () => {
    // The reason categories are archived and never deleted. `category_id` is
    // ON DELETE SET NULL, so deleting would silently move real spending out of
    // its grid row and into "uncategorised" with nothing to indicate it happened.
    const owner = await makeOwner('owner@burmy.test');
    const { sql } = await harness();

    const account = await accounts.createAccount(owner, {
      name: 'BoA Checking',
      type: 'checking',
      institution: null,
      lastFour: null,
    });
    const category = await categories.createCategory(owner, {
      name: 'Food',
      slug: 'food',
      kind: 'spending',
    });

    // A synthetic transaction. The importer arrives in M5; this is the minimum
    // row the schema accepts, so the archive guarantee can be tested now.
    await sql`
      insert into "finance_transactions"
        ("owner_id", "account_id", "transaction_date", "original_description",
         "amount_cents", "transaction_type", "category_id", "dedupe_key")
      values
        (${owner}, ${account.id}, '2026-08-01', 'VELVET TACO',
         2249, 'expense', ${category.id}, 'synthetic-key-1')
    `;

    await categories.archiveCategory(owner, category.id);

    const rows = await sql<{ category_id: string | null }[]>`
      select "category_id" from "finance_transactions"
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.category_id).toBe(category.id);
  });

  it('refuses to restore when a new category took the freed name', async () => {
    // Truthful failure: the owner must rename one of the two. Silently leaving it
    // archived, or clobbering the new one, would both be worse.
    const owner = await makeOwner('owner@burmy.test');
    const original = await categories.createCategory(owner, {
      name: 'Travel',
      slug: 'travel',
      kind: 'spending',
    });
    await categories.archiveCategory(owner, original.id);
    await categories.createCategory(owner, {
      name: 'Travel',
      slug: 'travel',
      kind: 'spending',
    });

    await expect(categories.restoreCategory(owner, original.id)).rejects.toThrow(
      errors.DuplicateNameError,
    );
  });

  it('restores when the name is still free', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const category = await categories.createCategory(owner, {
      name: 'Travel',
      slug: 'travel',
      kind: 'spending',
    });
    await categories.archiveCategory(owner, category.id);

    const restored = await categories.restoreCategory(owner, category.id);
    expect(restored.archivedAt).toBeNull();
    expect(await categories.listCategories(owner)).toHaveLength(1);
  });
});

describe('reordering', () => {
  async function seedThree(owner: string): Promise<string[]> {
    const created = [];
    for (const name of ['Mortgage', 'Gas', 'Food']) {
      created.push(
        await categories.createCategory(owner, {
          name,
          slug: name.toLowerCase(),
          kind: 'spending',
        }),
      );
    }
    return created.map((c) => c.id);
  }

  it('renumbers densely from zero', async () => {
    const owner = await makeOwner('owner@burmy.test');
    const [a, b, c] = await seedThree(owner);

    await categories.reorderCategories(owner, [c!, a!, b!]);

    const list = await categories.listCategories(owner);
    expect(list.map((x) => x.name)).toEqual(['Food', 'Mortgage', 'Gas']);
    expect(list.map((x) => x.sortOrder)).toEqual([0, 1, 2]);
  });

  it('leaves no duplicate sort orders', async () => {
    // Duplicates make the grid's row sequence depend on whatever secondary
    // ordering Postgres picks — which is how a row appears to move on its own.
    const owner = await makeOwner('owner@burmy.test');
    const ids = await seedThree(owner);

    await categories.reorderCategories(owner, [...ids].reverse());

    const orders = (await categories.listCategories(owner)).map((c) => c.sortOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('is a no-op for an empty list', async () => {
    const owner = await makeOwner('owner@burmy.test');
    await seedThree(owner);
    await expect(categories.reorderCategories(owner, [])).resolves.toBeUndefined();
  });
});

describe('cross-owner isolation', () => {
  it('never lists another owner rows', async () => {
    const alice = await makeOwner('alice@burmy.test');
    const bob = await makeOwner('bob@burmy.test');

    await categories.createCategory(alice, {
      name: 'Alice Food',
      slug: 'alice-food',
      kind: 'spending',
    });
    await accounts.createAccount(alice, {
      name: 'Alice Checking',
      type: 'checking',
      institution: null,
      lastFour: null,
    });

    expect(await categories.listCategories(bob)).toEqual([]);
    expect(await accounts.listAccounts(bob)).toEqual([]);
  });

  it('allows the SAME category name under two different owners', async () => {
    // The unique index is scoped to `owner_id`. If it were global, a second owner
    // could not exist — and the isolation tests below would pass for the wrong
    // reason.
    const alice = await makeOwner('alice@burmy.test');
    const bob = await makeOwner('bob@burmy.test');

    await categories.createCategory(alice, { name: 'Food', slug: 'food', kind: 'spending' });
    await expect(
      categories.createCategory(bob, { name: 'Food', slug: 'food', kind: 'spending' }),
    ).resolves.toBeTruthy();
  });

  it('cannot read another owner row by id', async () => {
    const alice = await makeOwner('alice@burmy.test');
    const bob = await makeOwner('bob@burmy.test');
    const secret = await categories.createCategory(alice, {
      name: 'Alice Food',
      slug: 'alice-food',
      kind: 'spending',
    });

    await expect(categories.getCategory(bob, secret.id)).rejects.toThrow(errors.NotFoundError);
  });

  it('cannot MUTATE another owner row by id', async () => {
    // The mutations match on (ownerId, id), never id alone. This is the shape of
    // an IDOR bug, and the assertion is what keeps it from being written later.
    const alice = await makeOwner('alice@burmy.test');
    const bob = await makeOwner('bob@burmy.test');
    const target = await categories.createCategory(alice, {
      name: 'Alice Food',
      slug: 'alice-food',
      kind: 'spending',
    });

    await expect(
      categories.updateCategory(bob, target.id, {
        name: 'Hijacked',
        slug: 'hijacked',
        kind: 'income',
      }),
    ).rejects.toThrow(errors.NotFoundError);

    await expect(categories.archiveCategory(bob, target.id)).rejects.toThrow(errors.NotFoundError);

    // Alice's row is untouched.
    const still = await categories.getCategory(alice, target.id);
    expect(still.name).toBe('Alice Food');
    expect(still.archivedAt).toBeNull();
  });

  it('cannot reorder another owner rows', async () => {
    const alice = await makeOwner('alice@burmy.test');
    const bob = await makeOwner('bob@burmy.test');

    const aliceIds = [];
    for (const name of ['One', 'Two', 'Three']) {
      aliceIds.push(
        (await categories.createCategory(alice, { name, slug: name.toLowerCase(), kind: 'spending' }))
          .id,
      );
    }

    // Bob submits Alice's ids in a different order.
    await categories.reorderCategories(bob, [...aliceIds].reverse());

    const list = await categories.listCategories(alice);
    expect(list.map((c) => c.name)).toEqual(['One', 'Two', 'Three']);
    expect(list.map((c) => c.sortOrder)).toEqual([0, 1, 2]);
  });

  it('ignores foreign ids without partially renumbering the owner own rows', async () => {
    // Ownership of the whole set is confirmed before any write, so a mixed
    // payload cannot leave a half-applied order.
    const alice = await makeOwner('alice@burmy.test');
    const bob = await makeOwner('bob@burmy.test');

    const bobIds = [];
    for (const name of ['B1', 'B2']) {
      bobIds.push(
        (await categories.createCategory(bob, { name, slug: name.toLowerCase(), kind: 'spending' }))
          .id,
      );
    }
    const aliceId = (
      await categories.createCategory(alice, { name: 'A1', slug: 'a1', kind: 'spending' })
    ).id;

    await categories.reorderCategories(bob, [bobIds[1]!, aliceId, bobIds[0]!]);

    const bobList = await categories.listCategories(bob);
    expect(bobList.map((c) => c.name)).toEqual(['B2', 'B1']);
    expect(bobList.map((c) => c.sortOrder)).toEqual([0, 1]);

    // Alice untouched.
    expect((await categories.listCategories(alice))[0]?.sortOrder).toBe(0);
  });
});
