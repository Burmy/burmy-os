/**
 * Owner-scoped data access for `finance_accounts`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY FUNCTION TAKES `ownerId` FIRST AND INJECTS IT INTO THE `WHERE` CLAUSE.
 *
 * That is the whole point of this layer. Server Actions and Route Handlers never
 * build queries themselves, so there is no code path that can read or write a row
 * without naming an owner. Plan §14 asks for this to be enforced "by API shape
 * and by integration tests" rather than by a custom lint rule — the API shape is
 * that `ownerId` is not optional and not defaulted.
 *
 * Note the mutations match on `(ownerId, id)`, never on `id` alone. With one
 * owner that is currently unreachable, but a mutation keyed only on a
 * client-supplied id is the exact shape of an IDOR bug, and it costs nothing to
 * not write it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { and, asc, eq } from 'drizzle-orm';

import { getDb } from '@/server/db';
import { financeAccounts } from '@/server/db/schema';
import { DuplicateNameError, NotFoundError, isUniqueViolation } from './errors';

/**
 * The types the UI offers.
 *
 * `cash` exists in the database enum from M1 but is deliberately NOT here: cash
 * spending is explicitly not tracked in V1, so offering the option would invite
 * data the importer has no way to produce.
 */
export const ACCOUNT_TYPES = ['checking', 'savings', 'credit_card', 'brokerage'] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];

export interface FinanceAccount {
  readonly id: string;
  readonly name: string;
  readonly institution: string | null;
  readonly type: AccountType;
  readonly lastFour: string | null;
  readonly isActive: boolean;
  readonly sortOrder: number;
}

export interface AccountInput {
  readonly name: string;
  readonly type: AccountType;
  readonly institution: string | null;
  readonly lastFour: string | null;
}

function rowToAccount(row: typeof financeAccounts.$inferSelect): FinanceAccount {
  return {
    id: row.id,
    name: row.name,
    institution: row.institution,
    type: row.type as AccountType,
    lastFour: row.lastFour,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
  };
}

export async function listAccounts(ownerId: string): Promise<FinanceAccount[]> {
  const rows = await getDb()
    .select()
    .from(financeAccounts)
    .where(eq(financeAccounts.ownerId, ownerId))
    .orderBy(asc(financeAccounts.sortOrder), asc(financeAccounts.name));

  return rows.map(rowToAccount);
}

export async function getAccount(ownerId: string, id: string): Promise<FinanceAccount> {
  const rows = await getDb()
    .select()
    .from(financeAccounts)
    .where(and(eq(financeAccounts.ownerId, ownerId), eq(financeAccounts.id, id)))
    .limit(1);

  const row = rows[0];
  if (!row) throw new NotFoundError('Account');
  return rowToAccount(row);
}

export async function createAccount(
  ownerId: string,
  input: AccountInput,
): Promise<FinanceAccount> {
  const existing = await listAccounts(ownerId);

  // Accounts have no database-level uniqueness on name — unlike categories,
  // which the grid's row axis depends on. Two "BoA Checking" entries would still
  // be a mistake though, so it is checked here and reported as a field error.
  const clash = existing.some(
    (account) => account.name.toLowerCase() === input.name.toLowerCase(),
  );
  if (clash) throw new DuplicateNameError(input.name);

  const rows = await getDb()
    .insert(financeAccounts)
    .values({
      ownerId,
      name: input.name,
      type: input.type,
      institution: input.institution,
      lastFour: input.lastFour,
      sortOrder: existing.length,
    })
    .returning();

  const row = rows[0];
  if (!row) throw new Error('Account insert returned no row');
  return rowToAccount(row);
}

export async function updateAccount(
  ownerId: string,
  id: string,
  input: AccountInput,
): Promise<FinanceAccount> {
  const existing = await listAccounts(ownerId);
  const clash = existing.some(
    (account) => account.id !== id && account.name.toLowerCase() === input.name.toLowerCase(),
  );
  if (clash) throw new DuplicateNameError(input.name);

  try {
    const rows = await getDb()
      .update(financeAccounts)
      .set({
        name: input.name,
        type: input.type,
        institution: input.institution,
        lastFour: input.lastFour,
        updatedAt: new Date(),
      })
      .where(and(eq(financeAccounts.ownerId, ownerId), eq(financeAccounts.id, id)))
      .returning();

    const row = rows[0];
    if (!row) throw new NotFoundError('Account');
    return rowToAccount(row);
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateNameError(input.name);
    throw error;
  }
}

/**
 * Deactivate or reactivate. There is NO delete.
 *
 * `finance_transactions.account_id` is `ON DELETE RESTRICT`, so an account with
 * history cannot be removed anyway — and an account without history today may
 * have history next month. Deactivating hides it from pickers while leaving every
 * past transaction attributable, which is the same reasoning that makes
 * categories archive rather than delete.
 */
export async function setAccountActive(
  ownerId: string,
  id: string,
  isActive: boolean,
): Promise<FinanceAccount> {
  const rows = await getDb()
    .update(financeAccounts)
    .set({ isActive, updatedAt: new Date() })
    .where(and(eq(financeAccounts.ownerId, ownerId), eq(financeAccounts.id, id)))
    .returning();

  const row = rows[0];
  if (!row) throw new NotFoundError('Account');
  return rowToAccount(row);
}
