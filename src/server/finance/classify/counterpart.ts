import { BOA_CARD_PAYMENT_RECEIVED_PATTERN } from '@/server/finance/adapters/boa-card';

/**
 * The full account-type enum, including `cash` — unlike
 * `import/compatibility.ts`'s `AccountType`, which deliberately excludes it
 * (no importable statement produces cash transactions). This module reads
 * arbitrary already-stored account rows, which could in principle carry any
 * value the database enum allows, so it is typed against the wider set.
 */
type AccountType = 'checking' | 'savings' | 'credit_card' | 'brokerage' | 'cash';

/**
 * Counterpart matching — ONE narrow mechanism, for transfers and credit-card
 * payments alike.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS SAFE TO AUTOMATE WHEN A BARE HEURISTIC WOULD NOT BE
 *
 * M4 found that BoA stamps both legs of a transfer or card payment with the
 * SAME confirmation token — `Confirmation# X` on checking, `CONF#X` on the
 * card — opposite signs, equal magnitude, days apart. That token is what turns
 * "is this a card payment" from a description-keyword guess (a heuristic,
 * exactly what CLAUDE.md invariant 5 forbids for exclusionary types) into a
 * deterministic cross-reference: two real transactions the bank itself linked.
 *
 * The match requires ALL of: same owner, same token (exact, after the LIKE
 * pre-filter — see imports.ts), exact negated-amount equality (opposite sign
 * AND equal magnitude in one comparison), a different account, within
 * `COUNTERPART_WINDOW_DAYS`, and — checked by the caller's SQL, not here —
 * the candidate's `type_source` still `'default'`. Zero or more-than-one
 * qualifying candidate means NO match: this is deliberately a single
 * exact-match lookup, not a scored/fuzzy matching engine.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const COUNTERPART_WINDOW_DAYS = 7;

/**
 * Extract the bank-assigned correlation token from a raw description, e.g.
 * `Confirmation# 4p9dnrwz6` or `CONF#4p9dnrwz6` → `4p9dnrwz6`. Lowercased so
 * comparison is exact but case-insensitive, matching the two forms BoA emits.
 */
export function extractConfirmationToken(description: string): string | null {
  const match = /\b(?:CONF#|Confirmation#)\s*([A-Za-z0-9]+)/i.exec(description);
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * `isoDate` ± `days`, both as `YYYY-MM-DD`. Computed via UTC epoch millis, not
 * local-time `Date` arithmetic — see the timezone-drift warning in
 * `parse/normalize.ts`'s `normalizeDate`.
 */
export function dateWindow(isoDate: string, days: number): { readonly start: string; readonly end: string } {
  const [year, month, day] = isoDate.split('-').map(Number);
  const base = Date.UTC(year!, month! - 1, day!);
  const DAY_MS = 86_400_000;
  const format = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  return { start: format(base - days * DAY_MS), end: format(base + days * DAY_MS) };
}

/** A committed transaction from the SQL-side pre-filter (owner, window, type_source='default', different account, description ILIKE the token). */
export interface CounterpartCandidate {
  readonly id: string;
  readonly amountCents: number;
  readonly description: string;
  readonly accountType: AccountType;
}

export interface QualifiedCounterpart {
  readonly id: string;
  readonly transactionType: 'transfer' | 'credit_card_payment';
}

/**
 * Reduce a SQL-prefiltered candidate pool to a single qualifying counterpart,
 * or null.
 *
 * The SQL query already narrowed by owner, date window, a different account,
 * `type_source = 'default'`, and an `ILIKE` on the token (a coarse substring
 * match). This re-checks the token EXACTLY (the ILIKE could theoretically
 * match a token that merely contains this one as a substring) and the amount
 * EXACTLY, then requires precisely one survivor.
 *
 * The type label — `transfer` vs `credit_card_payment` — depends on EITHER
 * side being a `credit_card` account, not just the candidate's: importing the
 * card statement second must resolve to the same label as importing it first.
 */
export function findQualifyingCounterpart(
  token: string,
  amountCents: number,
  thisAccountType: AccountType,
  candidates: readonly CounterpartCandidate[],
): QualifiedCounterpart | null {
  const matches = candidates.filter(
    (candidate) =>
      extractConfirmationToken(candidate.description) === token && candidate.amountCents === -amountCents,
  );

  if (matches.length !== 1) return null;

  const match = matches[0]!;
  const isCardPayment = thisAccountType === 'credit_card' || match.accountType === 'credit_card';

  return { id: match.id, transactionType: isCardPayment ? 'credit_card_payment' : 'transfer' };
}

/**
 * A narrower LOCAL fallback for when `findQualifyingCounterpart` cannot yet
 * resolve anything — e.g. the card statement was imported before its
 * matching checking statement exists at all, so there is genuinely no
 * committed counterpart to cross-reference yet. Unlike that function, this
 * never cross-references another transaction: it recognizes BoA's own exact
 * "payment received" description format on a credit-card account, requiring
 * the inflow direction to match too. Still deterministic — an exact anchored
 * pattern against text the bank itself generates, not a merchant name — but
 * a strictly weaker guarantee than a real cross-account match, so callers
 * must only use this once `findQualifyingCounterpart` has already returned
 * null, never in place of it.
 */
export function isKnownCardPaymentReceived(
  accountType: AccountType,
  description: string,
  amountCents: number, // Burmy's own convention: positive = outflow
): boolean {
  return (
    accountType === 'credit_card' &&
    amountCents < 0 &&
    BOA_CARD_PAYMENT_RECEIVED_PATTERN.test(description.trim())
  );
}
