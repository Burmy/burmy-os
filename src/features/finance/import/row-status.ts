import type { StatusTone } from '@/components/ui/status-badge';
import type { FinanceImportRowView } from '@/server/db/finance/imports';

export type RowBucket = 'ready' | 'attention' | 'duplicate' | 'excluded';

export const BUCKET_LABELS: Record<RowBucket, string> = {
  ready: 'Ready',
  attention: 'Needs attention',
  duplicate: 'Duplicate',
  excluded: 'Excluded',
};

export const BUCKET_TONE: Record<RowBucket, StatusTone> = {
  ready: 'positive',
  attention: 'attention',
  duplicate: 'muted',
  excluded: 'neutral',
};

/**
 * A row's bucket for the import review tabs — distinct from `decision` and
 * `suggestedType`, which are the M5/M6/item-2 data this is read FROM, not a
 * replacement for it. Checked in this order deliberately: a parse failure or
 * the owner's own manual exclude both mean the row is settled and will not
 * become a transaction, regardless of what category it happens to carry —
 * checking `categoryId` first would wrongly show a manually-excluded row
 * under "Needs attention."
 */
export function rowBucket(row: FinanceImportRowView): RowBucket {
  if (row.parseError !== null) return 'attention';
  if (row.decision === 'exclude') return row.decisionOverridden ? 'excluded' : 'duplicate';
  if (row.suggestedType === 'transfer' || row.suggestedType === 'credit_card_payment') return 'excluded';
  if (row.categoryId === null) return 'attention';
  return 'ready';
}

/** Truthful, derived from the row's own state — never a fixed string per bucket. */
export function rowReason(row: FinanceImportRowView, bucket: RowBucket): string {
  if (row.parseError !== null) return row.parseError;
  switch (bucket) {
    case 'ready':
      return row.categorizationSource === 'manual' ? 'Ready — category selected' : 'Ready — auto-categorized';
    case 'attention':
      return 'Needs attention — uncategorized';
    case 'duplicate':
      return 'Duplicate — already imported';
    case 'excluded':
      if (row.suggestedType === 'transfer') return 'Excluded — transfer';
      if (row.suggestedType === 'credit_card_payment') return 'Excluded — card payment';
      return 'Excluded — manually excluded';
  }
}
