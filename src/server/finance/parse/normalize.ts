import { type Cents, negate, parseMoney } from '@/server/finance/money';
import {
  ParseError,
  type NormalizedCandidate,
  type ParseResult,
  type SourceRow,
} from './types';

/**
 * STAGE 2 — source rows to typed candidates. Source-agnostic.
 *
 * Everything here is conversion and assertion. Nothing decides what a transaction
 * MEANS: no category, no type, no duplicate judgement, no database.
 */

/** Reject a date more than a year ahead, per plan §21's sanity rules. */
const MAX_FUTURE_DAYS = 365;

/** Reject a date more than thirty years back. */
const MAX_PAST_YEARS = 30;

/**
 * `MM/DD/YYYY` → `YYYY-MM-DD`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A MISSING YEAR IS REJECTED, NEVER INFERRED.
 *
 * Some statement formats print `05/17` with no year. Inferring one from the
 * statement period, or from "now", is how a December transaction lands in the
 * wrong year — and the monthly grid buckets on this exact value, so the error
 * shows up as a total that is wrong in two months at once and reconciles to
 * nothing. Refusing costs one clear error message.
 *
 * The result is a CALENDAR DAY string, never a `Date`. A timestamp would acquire a
 * timezone, and a timezone silently moves a late-evening purchase into the
 * previous or next month. See the note in schema.ts.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function normalizeDate(raw: string, lineNumber: number, now: Date = new Date()): string {
  const value = raw.trim();

  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  let year: number;
  let month: number;
  let day: number;

  if (slashed) {
    month = Number(slashed[1]);
    day = Number(slashed[2]);
    year = Number(slashed[3]);
  } else if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (/^\d{1,2}\/\d{1,2}$/.test(value)) {
    throw new ParseError(
      `date "${value}" has no year, and guessing one would move a transaction ` +
        `into the wrong month`,
      lineNumber,
    );
  } else {
    throw new ParseError(`unrecognized date format "${value}"`, lineNumber);
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new ParseError(`impossible date "${value}"`, lineNumber);
  }

  // Round-trip through UTC to reject 02/30 and similar, which `Date` would
  // otherwise roll forward into March without complaint.
  const asUtc = new Date(Date.UTC(year, month - 1, day));
  if (
    asUtc.getUTCFullYear() !== year ||
    asUtc.getUTCMonth() !== month - 1 ||
    asUtc.getUTCDate() !== day
  ) {
    throw new ParseError(`impossible date "${value}"`, lineNumber);
  }

  const futureLimit = new Date(now.getTime() + MAX_FUTURE_DAYS * 86_400_000);
  if (asUtc > futureLimit) {
    throw new ParseError(`date "${value}" is more than a year in the future`, lineNumber);
  }
  if (year < now.getUTCFullYear() - MAX_PAST_YEARS) {
    throw new ParseError(`date "${value}" is more than ${MAX_PAST_YEARS} years ago`, lineNumber);
  }

  const iso2 = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return iso2;
}

export interface NormalizeOptions {
  /**
   * Which column holds the transaction date, and which the posted date.
   *
   * BoA card exports provide ONLY `Posted Date`. `finance_transactions.transaction_date`
   * is NOT NULL and the monthly grid buckets on it, so for that format the single
   * date populates BOTH — recorded in docs/FINANCE.md as an observed limitation of
   * the source rather than a modelling choice. Fabricating an earlier transaction
   * date from a posted date would be inventing data.
   */
  readonly dateField: string;
  readonly postedDateField?: string | undefined;
  readonly descriptionField: string;
  readonly amountField: string;
  /** Where the bank's own identifier lives, if it provides one. */
  readonly sourceIdField?: string | undefined;
  readonly sourceCategoryField?: string | undefined;
  /** `now` is injectable so date-sanity tests do not drift as the calendar moves. */
  readonly now?: Date | undefined;
}

/**
 * Convert one source row.
 *
 * The amount arrives in the SOURCE convention (negative = outflow for both BoA
 * exports) and leaves in BURMY's (positive = outflow). The inversion happens here,
 * once, and `detectedDirection` records what was observed so a caller can assert
 * against it.
 *
 * Note `parseMoney` is literal — it does not convert conventions — while
 * `parseDebitCredit` already returns Burmy's. Mixing them up would invert twice
 * and produce a plausible, entirely wrong statement.
 */
export function normalizeRow(row: SourceRow, options: NormalizeOptions): NormalizedCandidate {
  const { fields, lineNumber } = row;

  const rawDate = fields[options.dateField];
  if (rawDate === undefined || rawDate === '') {
    throw new ParseError(`missing ${options.dateField}`, lineNumber);
  }

  const rawAmount = fields[options.amountField];
  if (rawAmount === undefined || rawAmount === '') {
    throw new ParseError(`missing ${options.amountField}`, lineNumber);
  }

  const description = (fields[options.descriptionField] ?? '').trim();
  if (description === '') {
    throw new ParseError(`missing ${options.descriptionField}`, lineNumber);
  }

  const transactionDate = normalizeDate(rawDate, lineNumber, options.now);

  const postedRaw =
    options.postedDateField === undefined ? undefined : fields[options.postedDateField];
  const postedDate =
    postedRaw === undefined || postedRaw === ''
      ? null
      : normalizeDate(postedRaw, lineNumber, options.now);

  const sourceAmount = parseMoney(rawAmount);
  const amountCents = negate(sourceAmount);

  const sourceId =
    options.sourceIdField === undefined ? undefined : fields[options.sourceIdField];
  const sourceCategory =
    options.sourceCategoryField === undefined
      ? undefined
      : fields[options.sourceCategoryField];

  return {
    lineNumber,
    transactionDate,
    postedDate,
    originalDescription: description,
    amountCents,
    // Reported from the SOURCE value: negative in the source means money left.
    detectedDirection: (sourceAmount as number) < 0 ? 'outflow' : 'inflow',
    sourceCategory: sourceCategory === undefined || sourceCategory === '' ? null : sourceCategory,
    sourceTransactionId: sourceId === undefined || sourceId === '' ? null : sourceId,
    currency: 'USD',
  };
}

export function normalizeRows(
  result: ParseResult,
  options: NormalizeOptions,
): NormalizedCandidate[] {
  return result.rows.map((row) => normalizeRow(row, options));
}

/**
 * The source-convention amounts, for the adapters' own assertions.
 *
 * Returned separately rather than folded into the candidates because the checks
 * that use them — the deposit summary reconciliation, the card all-inflow guard —
 * are stated in the source's own signs. Flipping them back to compare would be
 * one more chance to invert twice.
 */
export function sourceAmounts(result: ParseResult, amountField: string): number[] {
  return result.rows.map(
    (row) => parseMoney(row.fields[amountField] ?? '') as unknown as number,
  );
}

export type { Cents };
