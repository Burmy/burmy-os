/**
 * Owner-scoped READS of `finance_merchant_memory` — "what did I confirm for
 * this merchant before?"
 *
 * The write side (`upsertMerchantMemory`) lives inline in
 * `imports.ts`'s `commitImport()`, not here — it only ever runs inside that
 * function's already-open transaction, and M5 established the precedent of
 * not sharing a query across `Db` and a `Db['transaction']` callback's `tx`:
 * Drizzle's transaction type does not collapse into a small structural
 * interface, and duplicating one short query is cheaper than fighting that.
 * This file's `getDb()`-based read is used only at staging, outside any
 * transaction, so it has no such constraint.
 */

import { and, eq, inArray } from 'drizzle-orm';

import { getDb } from '@/server/db';
import { financeMerchantMemory } from '@/server/db/schema';

export interface MerchantMemoryEntry {
  readonly categoryId: string | null;
  readonly confirmedCount: number;
}

/**
 * Bulk lookup for an entire staged import at once, rather than one query per
 * row — an import can carry dozens of distinct merchants.
 */
export async function getMerchantMemoryForKeys(
  ownerId: string,
  merchantKeys: readonly string[],
): Promise<Map<string, MerchantMemoryEntry>> {
  if (merchantKeys.length === 0) return new Map();

  const rows = await getDb()
    .select({
      merchantKey: financeMerchantMemory.merchantKey,
      categoryId: financeMerchantMemory.categoryId,
      confirmedCount: financeMerchantMemory.confirmedCount,
    })
    .from(financeMerchantMemory)
    .where(
      and(
        eq(financeMerchantMemory.ownerId, ownerId),
        inArray(financeMerchantMemory.merchantKey, merchantKeys),
      ),
    );

  return new Map(
    rows.map((row) => [row.merchantKey, { categoryId: row.categoryId, confirmedCount: row.confirmedCount }]),
  );
}
