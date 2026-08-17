import {
  BOA_CARD_ADAPTER,
  assertCardHasOutflows,
  parseBoaCard,
} from '@/server/finance/adapters/boa-card';
import {
  BOA_DEPOSIT_ADAPTER,
  assertDepositTotals,
  assertRunningBalances,
  parseBoaDeposit,
} from '@/server/finance/adapters/boa-deposit';
import { splitCells } from './csv';
import { type NormalizeOptions, normalizeRow, normalizeRows, sourceAmounts } from './normalize';
import { ADAPTER_COLUMNS, hasAllColumns, headerSignature } from './signature';
import {
  ParseError,
  type AdapterId,
  type NormalizedCandidate,
  type ParseResult,
} from './types';

/**
 * The stage boundary, composed.
 *
 *   raw bytes ──▶ detect format ──▶ parse (source-specific) ──▶ normalize
 *
 * Everything downstream of this — merchant normalization, dedupe keys, duplicate
 * reconciliation, classification, categorization, persistence — is a SEPARATE
 * module and, from M5, a separate pipeline stage. This function deliberately
 * returns candidates and stops.
 */

export interface DetectedFormat {
  readonly adapter: AdapterId;
  readonly signature: string;
  readonly headers: readonly string[];
}

/**
 * Identify the format from its header row.
 *
 * Never from the filename: the real card export read during M4 was named for May
 * and covered 04/28–05/27, so even the period in its name was wrong.
 *
 * `generic` is returned when no known adapter matches — the file is not rejected,
 * it needs a one-time column mapping the owner confirms and Burmy remembers
 * (`finance_format_signatures`). The mapping UI is M5; what M4 owes is a correct
 * verdict and a stable signature to remember it by.
 */
export function detectFormat(bytes: Uint8Array): DetectedFormat {
  const { rows } = splitCells(bytes);

  for (const [adapter, required] of Object.entries(ADAPTER_COLUMNS)) {
    for (const row of rows) {
      if (row.length === 0) continue;
      if (hasAllColumns(row, required)) {
        return {
          adapter: adapter as AdapterId,
          signature: headerSignature(row),
          headers: row,
        };
      }
    }
  }

  // Fall back to the first non-empty row as the presumed header, so the unknown
  // format still gets a stable signature to be mapped against.
  const first = rows.find((row) => row.some((cell) => cell.trim() !== ''));
  if (!first) throw new ParseError('file contains no data');

  return { adapter: 'generic', signature: headerSignature(first), headers: first };
}

export interface StatementParse {
  readonly format: DetectedFormat;
  readonly result: ParseResult;
  readonly candidates: readonly NormalizedCandidate[];
}

interface DetectedParse {
  readonly format: DetectedFormat;
  readonly result: ParseResult;
  readonly options: NormalizeOptions;
}

/**
 * Format detection, adapter parsing, and the FILE-level assertions — shared by
 * `parseStatement` and `parseStatementTolerant`. What differs between them is
 * only how ROW-level normalization failures are handled, so everything above
 * that split lives here once.
 */
function detectAndParse(bytes: Uint8Array, now?: Date): DetectedParse {
  const format = detectFormat(bytes);

  if (format.adapter === BOA_DEPOSIT_ADAPTER) {
    const result = parseBoaDeposit(bytes);
    const amounts = sourceAmounts(result, 'amount');

    // The statement's own arithmetic. This is the strongest correctness signal
    // available, and it keeps working on data nobody has seen.
    if (result.summary) assertDepositTotals(result.summary, amounts);
    assertRunningBalances(result.summary, result.rows);

    return {
      format,
      result,
      options: {
        dateField: 'date',
        descriptionField: 'description',
        amountField: 'amount',
        ...(now ? { now } : {}),
      },
    };
  }

  if (format.adapter === BOA_CARD_ADAPTER) {
    const result = parseBoaCard(bytes);
    assertCardHasOutflows(sourceAmounts(result, 'amount'));

    return {
      format,
      result,
      options: {
        // Only ONE date exists in this format, so it populates both. Recorded in
        // docs/FINANCE.md as a source limitation — inventing an earlier
        // transaction date from a posted date would be fabricating data.
        dateField: 'posted_date',
        postedDateField: 'posted_date',
        descriptionField: 'payee',
        amountField: 'amount',
        // Captured as ADVISORY metadata only. Cross-export stability is
        // unverified, so nothing depends on it — see docs/FINANCE.md.
        sourceIdField: 'reference_number',
        ...(now ? { now } : {}),
      },
    };
  }

  throw new ParseError(
    `unrecognized statement format (signature ${format.signature}); ` +
      `a column mapping is required`,
  );
}

/**
 * Parse and normalize a statement, running every assertion the format supports.
 *
 * @throws ParseError — loudly, rather than returning a plausible wrong answer.
 */
export function parseStatement(bytes: Uint8Array, now?: Date): StatementParse {
  const { format, result, options } = detectAndParse(bytes, now);
  const candidates = normalizeRows(result, options);
  return { format, result, candidates };
}

export interface NormalizeFailure {
  readonly lineNumber: number;
  readonly message: string;
}

export interface TolerantStatementParse {
  readonly format: DetectedFormat;
  readonly result: ParseResult;
  readonly candidates: readonly NormalizedCandidate[];
  readonly failures: readonly NormalizeFailure[];
}

/**
 * Like `parseStatement`, but one bad ROW does not abort the whole file.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `parseStatement()` calls `normalizeRows()`, which maps over every row and
 * throws on the first one that fails — an impossible date, a missing field. For
 * M5's import pipeline that is too blunt: one malformed line in an otherwise
 * good statement would reject the entire file, when the product requirement is
 * for that one row to show up in the preview as "needs attention" instead.
 *
 * FILE-level assertions (the deposit checksum, the running balance, the
 * all-inflow guard) still throw — those mean the whole file is suspect, and no
 * partial import should proceed. Only the per-row `normalizeRow()` call is
 * wrapped, via `detectAndParse()`'s shared options rather than a duplicated
 * adapter branch.
 *
 * Additive: `parseStatement()` itself, and everything that tests it, is
 * unchanged.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function parseStatementTolerant(bytes: Uint8Array, now?: Date): TolerantStatementParse {
  const { format, result, options } = detectAndParse(bytes, now);

  const candidates: NormalizedCandidate[] = [];
  const failures: NormalizeFailure[] = [];

  for (const row of result.rows) {
    try {
      candidates.push(normalizeRow(row, options));
    } catch (error) {
      failures.push({
        lineNumber: row.lineNumber,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { format, result, candidates, failures };
}

export { detectFormat as detect };
export * from './types';
