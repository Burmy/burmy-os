import { revalidatePath } from 'next/cache';

/**
 * The three pages a transaction mutation is visible on.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS SHARED RATHER THAN REPEATED PER FEATURE
 *
 * Recategorizing a transaction, or changing its type, changes what THREE
 * screens show — and the same mutation functions
 * (`updateTransactionCategory` / `updateTransactionType`) are reachable from
 * two different features that each kept their own idea of what to
 * invalidate:
 *
 *   - `transactions/actions.ts` revalidated `/finance/transactions` and
 *     `/finance/monthly`, but never `/finance/review` — even though
 *     `reviewStatusForCorrection` means assigning a category is precisely
 *     what takes a row OUT of the review queue.
 *   - `review/actions.ts` revalidated `/finance/review` and nothing else —
 *     so confirming a category updated the queue while the Monthly grid,
 *     whose whole purpose is category totals, kept serving its cached
 *     render.
 *
 * Each file's list was right about its own page and wrong about the others,
 * which is the failure mode a per-feature list has: the author is looking at
 * one screen. There is exactly one correct answer here and it does not
 * depend on which button was pressed, so it lives in one place.
 *
 * `/finance/monthly` covers the Finance dashboard too — `FinanceDashboard`
 * renders on that route, not on one of its own.
 *
 * Not included: `/finance/import/[importId]`. An import's own preview is a
 * snapshot of what was staged, and correcting a committed transaction later
 * does not rewrite that history. Import actions revalidate their own paths
 * (`import/actions.ts`) and are not a transaction mutation in this sense.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function revalidateTransactionSurfaces(): void {
  revalidatePath('/finance/transactions');
  revalidatePath('/finance/monthly');
  revalidatePath('/finance/review');
}
