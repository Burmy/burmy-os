import type { Cents } from '@/server/finance/money';

/**
 * The two stages, kept deliberately apart.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *   raw bytes  ──parse──▶  SourceRow[]  ──normalize──▶  NormalizedCandidate[]
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * STAGE 1 — PARSE is source-specific and stays in the source's own vocabulary.
 * Every field is still a STRING exactly as the bank wrote it. Its only jobs are
 * finding the real header, splitting rows correctly, and labelling which column
 * is which. It makes no judgements about meaning.
 *
 * STAGE 2 — NORMALIZE is source-agnostic. It converts strings to typed values:
 * dates to ISO calendar days, amounts to `Cents` in BURMY's sign convention,
 * blank cells to null. It asserts the sign convention the adapter declared rather
 * than assuming it held.
 *
 * WHAT NEITHER STAGE DOES: categorize, decide duplicates, classify a transaction
 * type, write to a database, or call a model. A `NormalizedCandidate` is a
 * *candidate* precisely because nothing has yet decided whether it will be
 * imported. Those decisions belong to M5's pipeline and M6's classifier, which
 * consume this output.
 */

/** Which adapter produced a row. Persisted on `finance_import_files.adapter`. */
export type AdapterId = 'boa-deposit' | 'boa-card' | 'generic';

/**
 * One row, still in the source's own terms.
 *
 * `fields` is keyed by the NORMALIZED header name (see signature.ts), so an
 * adapter reads `fields['amount']` rather than counting columns — column order
 * has already changed once between BoA products and will change again.
 */
export interface SourceRow {
  /** 1-based line number in the original file, for error messages. */
  readonly lineNumber: number;
  readonly fields: Readonly<Record<string, string>>;
}

/** Why a line produced no transaction. Reported, never silently dropped. */
export type SkipReason =
  | 'blank-line'
  | 'preamble'
  | 'header'
  | 'balance-pseudo-row'
  | 'no-amount';

export interface SkippedLine {
  readonly lineNumber: number;
  readonly reason: SkipReason;
}

/**
 * The summary block some BoA deposit exports carry above the transactions.
 *
 * This is not decoration: the transaction rows reconcile to it exactly, which
 * makes it a checksum for the whole parse. See `assertDepositTotals`.
 */
export interface StatementSummary {
  readonly beginningBalance: Cents;
  readonly endingBalance: Cents;
  readonly totalCredits: Cents;
  readonly totalDebits: Cents;
}

export interface ParseResult {
  readonly adapter: AdapterId;
  /** Stable hash of the normalized header set — see signature.ts. */
  readonly signature: string;
  readonly rows: readonly SourceRow[];
  /** Every line that produced no row, with the reason. */
  readonly skipped: readonly SkippedLine[];
  /** Present only when the source carried a reconcilable summary block. */
  readonly summary: StatementSummary | null;
}

/** Which way the SOURCE signs its amounts. Burmy's own convention is the inverse. */
export type SourceSignConvention =
  /** One signed column where a negative number means money left the account. */
  | 'negative-is-outflow'
  /** Separate Debit and Credit columns. */
  | 'debit-credit-columns';

/**
 * A candidate transaction: typed, normalized, and not yet judged.
 *
 * Deliberately absent: `normalizedMerchant`, `merchantKey`, `dedupeKey`,
 * `transactionType`, `categoryId`. Merchant normalization and dedupe-key
 * computation are separate pure modules (`merchant.ts`, `dedupe.ts`) applied
 * *after* this stage, and composing them is the import pipeline's job in M5.
 * Folding them in here would make the parser responsible for identity and
 * classification, which is exactly the coupling this split exists to prevent.
 */
export interface NormalizedCandidate {
  readonly lineNumber: number;

  /** Calendar day, `YYYY-MM-DD`. Never a timestamp — see schema.ts on drift. */
  readonly transactionDate: string;
  readonly postedDate: string | null;

  /** Verbatim. The input to `dedupeKey`, so it must never be cleaned up. */
  readonly originalDescription: string;

  /** BURMY's convention: POSITIVE = outflow. Inverted from both BoA exports. */
  readonly amountCents: Cents;

  /**
   * What the adapter OBSERVED, so the normalizer can assert rather than assume.
   * Kept because a whole statement of one direction is the signature of an
   * inverted parse.
   */
  readonly detectedDirection: 'outflow' | 'inflow';

  /** The bank's own category, where it provides one. Neither export does. */
  readonly sourceCategory: string | null;

  /**
   * The bank-provided identifier, captured but NOT TRUSTED.
   *
   * For BoA card exports this is `Reference Number`. It is stored as advisory
   * metadata only: cross-export stability is unverified, so there is no unique
   * constraint and duplicate detection does not depend on it (Tier 2 does all the
   * work — see docs/FINANCE.md).
   *
   * Capturing it now is what makes the Tier 1 verification a later comparison
   * rather than a parser rewrite.
   */
  readonly sourceTransactionId: string | null;

  readonly currency: 'USD';
}

/** A parse or normalize failure that names a LINE, never row content. */
export class ParseError extends Error {
  constructor(
    message: string,
    readonly lineNumber: number | null = null,
  ) {
    super(lineNumber === null ? message : `line ${lineNumber}: ${message}`);
    this.name = 'ParseError';
  }
}
