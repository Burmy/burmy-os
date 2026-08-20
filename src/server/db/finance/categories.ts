/**
 * Owner-scoped data access for `finance_categories` — the grid's row axis.
 *
 * Same rule as accounts.ts: `ownerId` is the first parameter of every function
 * and goes into every `WHERE`. See that file's header for why.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CATEGORIES ARE ARCHIVED, NEVER DELETED.
 *
 * A category is referenced by every transaction ever assigned to it. Deleting one
 * would either orphan those rows (`category_id` is `ON DELETE SET NULL`, so they
 * would silently become uncategorised and vanish from their grid row) or require
 * rewriting history. Archiving sets `archived_at`, which hides it from pickers and
 * frees its name for reuse while leaving every past total intact.
 *
 * The partial unique index from M1 is what makes reuse safe:
 *   unique (owner_id, lower(name)) WHERE archived_at IS NULL
 * So an archived "Travel" does not block creating a new "Travel", but two live
 * ones are impossible — including via a race, because the database decides.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

import { getDb } from '@/server/db';
import { financeCategories, financeTransactions } from '@/server/db/schema';
import { denseOrder } from '@/server/finance/taxonomy';
import { CategoryInUseError, DuplicateNameError, NotFoundError, isUniqueViolation } from './errors';

/** Drives grid sectioning and subtotals. See docs/FINANCE.md. */
export const CATEGORY_KINDS = ['spending', 'income', 'investment'] as const;

export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export interface FinanceCategory {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly kind: CategoryKind;
  readonly sortOrder: number;
  readonly archivedAt: Date | null;
}

export interface CategoryInput {
  readonly name: string;
  readonly slug: string;
  readonly kind: CategoryKind;
}

function rowToCategory(row: typeof financeCategories.$inferSelect): FinanceCategory {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    kind: row.kind as CategoryKind,
    sortOrder: row.sortOrder,
    archivedAt: row.archivedAt,
  };
}

export interface ListCategoriesOptions {
  /** Include archived rows. Defaults to false — pickers must not offer them. */
  readonly includeArchived?: boolean;
}

export async function listCategories(
  ownerId: string,
  options: ListCategoriesOptions = {},
): Promise<FinanceCategory[]> {
  const where =
    options.includeArchived === true
      ? eq(financeCategories.ownerId, ownerId)
      : and(eq(financeCategories.ownerId, ownerId), isNull(financeCategories.archivedAt));

  const rows = await getDb()
    .select()
    .from(financeCategories)
    .where(where)
    .orderBy(asc(financeCategories.sortOrder), asc(financeCategories.name));

  return rows.map(rowToCategory);
}

export async function getCategory(ownerId: string, id: string): Promise<FinanceCategory> {
  const rows = await getDb()
    .select()
    .from(financeCategories)
    .where(and(eq(financeCategories.ownerId, ownerId), eq(financeCategories.id, id)))
    .limit(1);

  const row = rows[0];
  if (!row) throw new NotFoundError('Category');
  return rowToCategory(row);
}

export async function createCategory(
  ownerId: string,
  input: CategoryInput,
): Promise<FinanceCategory> {
  const live = await listCategories(ownerId);

  try {
    const rows = await getDb()
      .insert(financeCategories)
      .values({
        ownerId,
        name: input.name,
        slug: input.slug,
        kind: input.kind,
        sortOrder: live.length,
      })
      .returning();

    const row = rows[0];
    if (!row) throw new Error('Category insert returned no row');
    return rowToCategory(row);
  } catch (error) {
    // Let the DATABASE decide uniqueness rather than pre-checking and hoping.
    // A pre-check plus an insert is a race; the partial unique index is not.
    if (isUniqueViolation(error)) throw new DuplicateNameError(input.name);
    throw error;
  }
}

export async function updateCategory(
  ownerId: string,
  id: string,
  input: CategoryInput,
): Promise<FinanceCategory> {
  try {
    const rows = await getDb()
      .update(financeCategories)
      .set({
        name: input.name,
        slug: input.slug,
        kind: input.kind,
        updatedAt: new Date(),
      })
      .where(and(eq(financeCategories.ownerId, ownerId), eq(financeCategories.id, id)))
      .returning();

    const row = rows[0];
    if (!row) throw new NotFoundError('Category');
    return rowToCategory(row);
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateNameError(input.name);
    throw error;
  }
}

/**
 * Archive. The row stays, and every transaction pointing at it stays valid.
 */
export async function archiveCategory(ownerId: string, id: string): Promise<FinanceCategory> {
  const rows = await getDb()
    .update(financeCategories)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(financeCategories.ownerId, ownerId), eq(financeCategories.id, id)))
    .returning();

  const row = rows[0];
  if (!row) throw new NotFoundError('Category');
  return rowToCategory(row);
}

/**
 * Un-archive.
 *
 * Can legitimately fail: if a NEW category took the freed name while this one was
 * archived, restoring would violate the partial unique index. That surfaces as a
 * duplicate-name error, which is the truthful thing to tell the owner — they must
 * rename one of the two.
 */
export async function restoreCategory(ownerId: string, id: string): Promise<FinanceCategory> {
  try {
    const rows = await getDb()
      .update(financeCategories)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(and(eq(financeCategories.ownerId, ownerId), eq(financeCategories.id, id)))
      .returning();

    const row = rows[0];
    if (!row) throw new NotFoundError('Category');
    return rowToCategory(row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      const current = await getCategory(ownerId, id);
      throw new DuplicateNameError(current.name);
    }
    throw error;
  }
}

/**
 * True delete — the one case Archive doesn't cover: a category created by
 * mistake (a typo, a duplicate, an experiment) that was never actually used.
 * Every other category, with real history, stays archive-only; see
 * `CategoryInUseError`'s own doc comment for why.
 *
 * @throws CategoryInUseError · NotFoundError
 */
export async function deleteCategory(ownerId: string, id: string): Promise<void> {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(financeTransactions)
    .where(and(eq(financeTransactions.ownerId, ownerId), eq(financeTransactions.categoryId, id)));

  const transactionCount = row?.count ?? 0;
  if (transactionCount > 0) throw new CategoryInUseError(transactionCount);

  const deleted = await getDb()
    .delete(financeCategories)
    .where(and(eq(financeCategories.ownerId, ownerId), eq(financeCategories.id, id)))
    .returning();

  if (!deleted[0]) throw new NotFoundError('Category');
}

/**
 * One `GROUP BY` for the whole list rather than one query per category — the
 * Settings page needs this to decide which categories can offer Delete
 * (zero transactions) versus Archive-only.
 */
export async function getCategoryTransactionCounts(ownerId: string): Promise<Map<string, number>> {
  const rows = await getDb()
    .select({ categoryId: financeTransactions.categoryId, count: sql<number>`count(*)::int` })
    .from(financeTransactions)
    .where(and(eq(financeTransactions.ownerId, ownerId), isNotNull(financeTransactions.categoryId)))
    .groupBy(financeTransactions.categoryId);

  return new Map(rows.map((r) => [r.categoryId!, r.count]));
}

/**
 * Persist a new order for the live categories.
 *
 * Runs in ONE transaction, renumbering densely from 0. Partially applied
 * reordering would leave duplicate `sort_order` values, and then the grid's row
 * sequence depends on whatever secondary ordering Postgres happens to pick —
 * which is how a row appears to move on its own between page loads.
 *
 * Ids not belonging to the owner are ignored rather than rejected: the `inArray`
 * guard below is scoped by `ownerId`, so a crafted id simply matches nothing.
 */
export async function reorderCategories(ownerId: string, orderedIds: string[]): Promise<void> {
  if (orderedIds.length === 0) return;

  await getDb().transaction(async (tx) => {
    // Confirm ownership of the whole set first, so a crafted id cannot cause a
    // partial renumber of the rows that DO belong to the owner.
    const owned = await tx
      .select({ id: financeCategories.id })
      .from(financeCategories)
      .where(
        and(eq(financeCategories.ownerId, ownerId), inArray(financeCategories.id, orderedIds)),
      );

    const ownedIds = new Set(owned.map((row) => row.id));
    const applicable = orderedIds.filter((id) => ownedIds.has(id));

    for (const { id, sortOrder } of denseOrder(applicable)) {
      await tx
        .update(financeCategories)
        .set({ sortOrder, updatedAt: new Date() })
        .where(and(eq(financeCategories.ownerId, ownerId), eq(financeCategories.id, id)));
    }
  });
}
