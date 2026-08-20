'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireOwner } from '@/server/auth/owner';
import {
  CATEGORY_KINDS,
  archiveCategory,
  createCategory,
  deleteCategory,
  reorderCategories,
  restoreCategory,
  updateCategory,
} from '@/server/db/finance/categories';
import { CategoryInUseError, DuplicateNameError, NotFoundError } from '@/server/db/finance/errors';
import { InvalidNameError, assertValidName, slugifyName } from '@/server/finance/taxonomy';
import { type ActionResult, fail, ok } from './action-result';

/**
 * Server Actions for categories — the grid's row axis.
 *
 * Every one begins with `await requireOwner()`. See account-actions.ts.
 */

const categorySchema = z.object({
  name: z.string(),
  kind: z.enum(CATEGORY_KINDS),
});

const idSchema = z.string().uuid();

function toResult(error: unknown): ActionResult {
  if (error instanceof InvalidNameError) return fail(error.message, 'name');
  if (error instanceof DuplicateNameError) {
    return fail(
      `"${error.duplicateName}" already exists. Archived categories do not conflict — check whether it is archived.`,
      'name',
    );
  }
  if (error instanceof NotFoundError) return fail(error.message);
  if (error instanceof CategoryInUseError) return fail(error.message);
  throw error;
}

function parse(formData: FormData): {
  name: string;
  slug: string;
  kind: (typeof CATEGORY_KINDS)[number];
} {
  const raw = categorySchema.parse({
    name: formData.get('name') ?? '',
    kind: formData.get('kind') ?? '',
  });

  const name = assertValidName(raw.name);

  return { name, slug: slugifyName(name), kind: raw.kind };
}

export async function createCategoryAction(formData: FormData): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    await createCategory(owner.userId, parse(formData));
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/settings/finance/categories');
  revalidatePath('/finance/monthly');
  return ok();
}

export async function updateCategoryAction(id: string, formData: FormData): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    await updateCategory(owner.userId, idSchema.parse(id), parse(formData));
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/settings/finance/categories');
  revalidatePath('/finance/monthly');
  return ok();
}

/**
 * Archive — the only option for a category with real transaction history.
 * Every transaction ever assigned to it keeps pointing at it; deleting would
 * set those `category_id`s to null and silently move real spending out of
 * its grid row. `deleteCategoryAction` below covers the other case — a
 * category with zero transactions, where there is nothing to orphan.
 */
export async function archiveCategoryAction(id: string): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    await archiveCategory(owner.userId, idSchema.parse(id));
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/settings/finance/categories');
  revalidatePath('/finance/monthly');
  return ok();
}

export async function restoreCategoryAction(id: string): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    await restoreCategory(owner.userId, idSchema.parse(id));
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/settings/finance/categories');
  revalidatePath('/finance/monthly');
  return ok();
}

/** @throws nothing to the caller — CategoryInUseError becomes a field error via toResult(). */
export async function deleteCategoryAction(id: string): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    await deleteCategory(owner.userId, idSchema.parse(id));
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/settings/finance/categories');
  revalidatePath('/finance/monthly');
  return ok();
}

/**
 * Persist a reordering.
 *
 * The client sends the full ordered list of live ids rather than "move X up",
 * so the server writes one dense sequence in a single transaction and there is no
 * way to end up with duplicate `sort_order` values from interleaved clicks.
 */
export async function reorderCategoriesAction(orderedIds: string[]): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    await reorderCategories(owner.userId, z.array(idSchema).max(500).parse(orderedIds));
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/settings/finance/categories');
  revalidatePath('/finance/monthly');
  return ok();
}
