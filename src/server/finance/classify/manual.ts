/**
 * M7's one piece of decision logic: when does an OWNER-DRIVEN correction
 * resolve a transaction, versus leave it needing more?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO CONFIRMED-BUT-UNCATEGORIZED SPENDING
 *
 * `finance_categories` is the row axis of M8's monthly grid, so a `confirmed`
 * expense with no category would have nowhere trustworthy to appear. The rule
 * (owner instruction, M7): confirmed requires a category, UNLESS the
 * transaction is one of the three EXCLUSIONARY types — those never appear in
 * a spending category total in the first place (that is what exclusionary
 * means), so requiring a category from them would serve nothing.
 *
 * This is the only thing that decides whether an M7 action lands on
 * `confirmed` or leaves a row at `needs_review`. It is deliberately NOT the
 * same rule as `import/staging.ts`'s `reviewStatusFor` — that one is about
 * whether a category came from the OWNER or from memory (`confirmed` vs
 * `auto`); this one is about whether `confirmed` is reachable AT ALL without
 * one. `reviewStatusFor` still governs a transaction reverting to its default
 * type when a counterpart pair is unlinked, below — that transaction is
 * reverting, not being corrected, so its status should reflect whatever
 * categorization it already had, not this rule.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * The full `transaction_type` enum has 8 values; `'adjustment'` is excluded
 * here on purpose. It reads as an internal bookkeeping concept (a balance
 * correction) rather than a "kind of transaction" an owner would
 * intentionally hand-pick, unlike the other seven — CLAUDE.md's "don't expose
 * a raw enum value merely because it exists." The database column still
 * accepts it; nothing this milestone builds can produce or require it. This
 * is the SAME list the manual type picker's Zod validation uses — the UI
 * cannot offer, and the server cannot accept via this path, anything outside
 * it.
 */
export const MANUAL_TRANSACTION_TYPES = [
  'expense',
  'refund',
  'fee',
  'income',
  'transfer',
  'credit_card_payment',
  'investment',
] as const;

export type ManualTransactionType = (typeof MANUAL_TRANSACTION_TYPES)[number];

export const EXCLUSIONARY_TRANSACTION_TYPES = ['transfer', 'credit_card_payment', 'investment'] as const;

export function isExclusionaryType(transactionType: string): boolean {
  return (EXCLUSIONARY_TRANSACTION_TYPES as readonly string[]).includes(transactionType);
}

/**
 * The result of an OWNER-DRIVEN category or type correction — never `'auto'`,
 * which is reserved for the system's own classification (M6). An owner acting
 * always produces either a resolved `'confirmed'` or an honest `'needs_review'`.
 */
export function reviewStatusForCorrection(
  categoryId: string | null,
  transactionType: string,
): 'confirmed' | 'needs_review' {
  return categoryId !== null || isExclusionaryType(transactionType) ? 'confirmed' : 'needs_review';
}

/**
 * All 8 real `transaction_type` values, for DISPLAY — unlike
 * `MANUAL_TRANSACTION_TYPES`, which deliberately excludes `adjustment` from
 * what an owner can newly PICK. M8's drill-down can show a transaction of any
 * real type (an old `adjustment` row included), so it needs a label for all
 * of them, not just the pickable seven.
 */
export const TRANSACTION_TYPE_LABELS: Readonly<Record<string, string>> = {
  expense: 'Expense',
  refund: 'Refund',
  fee: 'Fee',
  adjustment: 'Adjustment',
  income: 'Income',
  transfer: 'Transfer',
  credit_card_payment: 'Credit Card Payment',
  investment: 'Investment',
};
