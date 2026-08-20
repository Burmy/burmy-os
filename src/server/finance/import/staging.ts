import { reconcileCounts } from '@/server/finance/dedupe';
import type { LocationHint } from '@/server/finance/merchant';
import type { Cents } from '@/server/finance/money';

/**
 * Turning M4's Tier 2 counts into a per-row default — pure, and reused twice.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `planStagedDecisions` runs at STAGING time (against the committed count as of
 * upload) AND again inside `commitImport()`'s transaction (against the committed
 * count as of commit, restricted to rows the owner has not touched). Same
 * function, different snapshot of `committedByKey` — see
 * `src/server/db/finance/imports.ts` for why a second run at commit time closes
 * a race between two concurrently staged imports.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface StagingCandidate {
  /** `finance_import_rows.row_number` — the tie-break for which rows are surplus. */
  readonly rowNumber: number;
  readonly dedupeKey: string;
}

export interface CommittedMatch {
  readonly count: number;
  /** One committed transaction sharing the key, for the preview's "already imported" link. */
  readonly sampleTransactionId: string;
}

export interface StagedDecision {
  readonly rowNumber: number;
  readonly decision: 'include' | 'exclude';
  readonly duplicateOfTransactionId: string | null;
}

/**
 * Default include/exclude for a batch of candidates sharing one import.
 *
 * Groups by `dedupeKey`, reconciles each group against `committedByKey`, and
 * marks the first `surplus` rows — by `rowNumber`, ascending — as new. Rows
 * within a group are otherwise interchangeable (two genuine same-day coffees ARE
 * indistinguishable), so which specific row represents the surplus is an
 * implementation detail, not a decision the owner needs to make.
 */
export function planStagedDecisions(
  candidates: readonly StagingCandidate[],
  committedByKey: ReadonlyMap<string, CommittedMatch>,
): StagedDecision[] {
  const groups = new Map<string, StagingCandidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.dedupeKey);
    if (group) group.push(candidate);
    else groups.set(candidate.dedupeKey, [candidate]);
  }

  const decisions: StagedDecision[] = [];

  for (const [key, group] of groups) {
    const committed = committedByKey.get(key);
    const { surplus } = reconcileCounts({
      stagedCount: group.length,
      committedCount: committed?.count ?? 0,
    });

    const ordered = [...group].sort((a, b) => a.rowNumber - b.rowNumber);

    ordered.forEach((candidate, index) => {
      const isNew = index < surplus;
      decisions.push({
        rowNumber: candidate.rowNumber,
        decision: isNew ? 'include' : 'exclude',
        duplicateOfTransactionId: isNew ? null : (committed?.sampleTransactionId ?? null),
      });
    });
  }

  return decisions;
}

/**
 * The only transaction type M5 ever assigns, by the sign of the amount alone.
 *
 * Never `transfer`, `credit_card_payment` or `investment` — CLAUDE.md invariant
 * 5 requires deterministic evidence for those (a rule, a matched counterpart, or
 * explicit confirmation), and M5 has no such evidence source. Classifying by
 * sign only ever produces a NON-exclusionary type, so nothing is ever invisibly
 * removed from spending totals. Refining `expense`/`income` into `refund`,
 * `fee`, etc. is M6's job.
 */
export function defaultTransactionType(amountCents: Cents): 'expense' | 'income' {
  return amountCents > 0 ? 'expense' : 'income';
}

/**
 * `confirmed` — the OWNER picked this category (`categorizationSource ===
 * 'manual'`). `auto` — the system suggested it from merchant memory and
 * nothing overrode that, OR the transaction needs no category at all.
 * `needs_review` — no category, and one is actually needed. This is the
 * "obvious vs uncertain" split M6 exists to produce: an owner reviewing their
 * import only needs to look at `needs_review` rows.
 *
 * `income` is the one type that never needs a category to leave `needs_review`
 * — see `reviewStatusForCorrection`'s own comment for why. A category-less
 * income deposit is `auto`: nothing was actually suggested, but nothing needs
 * the owner's attention either.
 */
export function reviewStatusFor(
  categoryId: string | null,
  categorizationSource: 'manual' | 'merchant_memory' | null,
  transactionType: 'expense' | 'income',
): 'confirmed' | 'auto' | 'needs_review' {
  if (categoryId === null) return transactionType === 'income' ? 'auto' : 'needs_review';
  return categorizationSource === 'manual' ? 'confirmed' : 'auto';
}

/**
 * BoA card exports pack `Address` as city left-justified in 14 columns, then
 * the state, then a trailing space (`adapters/boa-card.ts`) — e.g.
 * `"SPRINGFIELD   TX "`. Never assume the exact column width; trim and split
 * from the END instead, which is robust to the padding and to a future export
 * that pads differently. Blank on payment rows, and on any row where the
 * two-letter-state shape does not hold.
 *
 * `ParseResult.rows` still carries this field (M4 discards it only at
 * staging), which is what lets the import pipeline use it as an exact
 * location hint for `normalizeMerchant` without ever persisting it.
 */
export function parseBoaCardAddressHint(raw: string | undefined): LocationHint | undefined {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length < 3) return undefined;

  const state = trimmed.slice(-2).toUpperCase();
  const city = trimmed.slice(0, -2).trim();
  if (city === '' || !/^[A-Z]{2}$/.test(state)) return undefined;

  return { city, state };
}
