'use server';

import { z } from 'zod';

import { requireOwner } from '@/server/auth/owner';
import { type DrillDownTransaction, getCellTransactions } from '@/server/db/finance/grid';

/**
 * Read-only, but still a Server Action begun with `await requireOwner()` —
 * the entry-points enumeration test does not distinguish reads from writes,
 * and neither should the guard: this is still an owner-scoped query over
 * financial data reached from client interaction.
 */

const selectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('category'), categoryId: z.string().uuid() }),
  z.object({ kind: z.literal('expenditure') }),
  z.object({ kind: z.literal('income') }),
]);

export interface DrillDownResult {
  readonly transactions: readonly DrillDownTransaction[];
  /** Summed here from the same rows returned to the caller — the visible proof the dialog's total agrees with the list under it. */
  readonly totalCents: number;
}

export async function getCellDrillDownAction(
  year: number,
  month: number | null,
  selector: z.infer<typeof selectorSchema>,
): Promise<DrillDownResult> {
  const owner = await requireOwner();

  const parsedYear = z.number().int().min(2000).max(2100).parse(year);
  const parsedMonth = month === null ? null : z.number().int().min(1).max(12).parse(month);
  const parsedSelector = selectorSchema.parse(selector);

  const transactions = await getCellTransactions(owner.userId, parsedYear, parsedMonth, parsedSelector);
  const totalCents = transactions.reduce((sum, transaction) => sum + transaction.amountCents, 0);

  return { transactions, totalCents };
}
