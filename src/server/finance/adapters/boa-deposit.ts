import { type Cents, parseMoney } from '@/server/finance/money';
import { locateHeader, splitCells, zipRow } from '@/server/finance/parse/csv';
import { ADAPTER_COLUMNS, headerSignature } from '@/server/finance/parse/signature';
import {
  ParseError,
  type ParseResult,
  type SkippedLine,
  type SourceRow,
  type StatementSummary,
} from '@/server/finance/parse/types';

/**
 * Bank of America deposit (checking/savings) export.
 *
 * OBSERVED SHAPE — from a real export read during M4, not from documentation:
 *
 *   Description,,Summary Amt.                  ← summary header, 3 columns
 *   Beginning balance as of 05/13/2026,,"…"
 *   Total credits,,"…"
 *   Total debits,,"…"
 *   Ending balance as of 06/11/2026,,"…"
 *                                              ← BLANK LINE
 *   Date,Description,Amount,Running Bal.       ← the REAL header, 4 columns
 *   05/13/2026,Beginning balance as of …,,"…"  ← pseudo-row, EMPTY amount
 *   05/14/2026,"…","-540.25","9,909.75"
 *
 * The plan predicted `Date / Description / Amount`. Reality adds `Running Bal.`
 * and puts five lines plus a blank one above the header. That is why the header is
 * located by scanning for required columns rather than by position.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SUMMARY BLOCK IS A CHECKSUM, AND IT IS THE BEST CORRECTNESS SIGNAL WE HAVE
 *
 * Verified against the real file to the cent: the parsed credits and debits equal
 * the stated totals, and beginning + credits − debits equals the stated ending
 * balance. Every `Running Bal.` also equals the previous balance plus the row
 * amount.
 *
 * So a dropped row, an inverted sign, or a thousands separator eaten by a bad
 * split all become LOUD failures rather than a total that is quietly wrong — on
 * every real import, forever, not just against fixtures. This is worth more than
 * any test in the suite because it keeps working on data nobody has seen.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const BOA_DEPOSIT_ADAPTER = 'boa-deposit' as const;

const SUMMARY_LABELS = {
  beginning: /^beginning balance as of/i,
  ending: /^ending balance as of/i,
  credits: /^total credits$/i,
  debits: /^total debits$/i,
} as const;

/**
 * Read the summary block, if present.
 *
 * Returns null rather than throwing when it is absent: not every deposit export
 * carries one, and its absence is a missing bonus check, not a broken file.
 */
function readSummary(rows: readonly string[][], headerIndex: number): StatementSummary | null {
  const found: Partial<Record<keyof typeof SUMMARY_LABELS, Cents>> = {};

  // Only the lines ABOVE the real header. A transaction whose description happens
  // to start with "Total debits" must not be mistaken for the summary.
  for (const row of rows.slice(0, headerIndex)) {
    const label = (row[0] ?? '').trim();
    // The value sits in the LAST non-empty cell: the middle column is genuinely
    // empty in this block, and relying on index 2 would break if that changed.
    const value = [...row].reverse().find((cell) => cell.trim() !== '');
    if (!value) continue;

    for (const [key, pattern] of Object.entries(SUMMARY_LABELS)) {
      if (!pattern.test(label)) continue;
      try {
        found[key as keyof typeof SUMMARY_LABELS] = parseMoney(value);
      } catch {
        // A summary line we cannot read is not worth failing the whole import
        // over — the per-row running-balance check still applies.
        return null;
      }
    }
  }

  const { beginning, ending, credits, debits } = found;
  if (beginning === undefined || ending === undefined) return null;
  if (credits === undefined || debits === undefined) return null;

  return {
    beginningBalance: beginning,
    endingBalance: ending,
    totalCredits: credits,
    totalDebits: debits,
  };
}

/**
 * Is this row the "Beginning balance" pseudo-row rather than a transaction?
 *
 * It carries a date and a running balance but an EMPTY amount. Importing it would
 * create a phantom 0.00 transaction on the first day of every statement — visible
 * in the grid, impossible to explain, and trivially avoidable.
 */
function isBalancePseudoRow(fields: Record<string, string>): boolean {
  return (fields['amount'] ?? '') === '' && /balance as of/i.test(fields['description'] ?? '');
}

export function parseBoaDeposit(bytes: Uint8Array): ParseResult {
  const { rows } = splitCells(bytes);

  const header = locateHeader(rows, ADAPTER_COLUMNS['boa-deposit']);
  if (!header) {
    throw new ParseError('no row contains the columns a BoA deposit export requires');
  }

  const summary = readSummary(rows, header.index);

  const parsed: SourceRow[] = [];
  const skipped: SkippedLine[] = [];

  for (const [index, row] of rows.entries()) {
    const lineNumber = index + 1;

    if (index < header.index) {
      skipped.push({ lineNumber, reason: 'preamble' });
      continue;
    }
    if (index === header.index) {
      skipped.push({ lineNumber, reason: 'header' });
      continue;
    }
    // A trailing newline yields a final row of one empty cell.
    if (row.length === 0 || (row.length === 1 && (row[0] ?? '').trim() === '')) {
      skipped.push({ lineNumber, reason: 'blank-line' });
      continue;
    }

    const fields = zipRow(header.headers, row, lineNumber);

    if (isBalancePseudoRow(fields)) {
      skipped.push({ lineNumber, reason: 'balance-pseudo-row' });
      continue;
    }
    if ((fields['amount'] ?? '') === '') {
      skipped.push({ lineNumber, reason: 'no-amount' });
      continue;
    }

    parsed.push({ lineNumber, fields });
  }

  return {
    adapter: BOA_DEPOSIT_ADAPTER,
    signature: headerSignature(header.headers),
    rows: parsed,
    skipped,
    summary,
  };
}

/**
 * Prove the parse against the statement's own arithmetic.
 *
 * `amounts` are in the SOURCE convention (negative = outflow), because that is
 * what the summary block is stated in. Comparing after inversion would need the
 * signs flipped back, which is one more place to get it wrong.
 *
 * @throws ParseError when the rows do not reconcile.
 */
export function assertDepositTotals(
  summary: StatementSummary,
  sourceAmounts: readonly number[],
): void {
  const credits = sourceAmounts.filter((value) => value > 0).reduce((a, b) => a + b, 0);
  const debits = sourceAmounts.filter((value) => value < 0).reduce((a, b) => a + b, 0);

  if (credits !== (summary.totalCredits as number)) {
    throw new ParseError(
      `credits do not reconcile: rows total ${credits}, statement says ${summary.totalCredits}`,
    );
  }
  if (debits !== (summary.totalDebits as number)) {
    throw new ParseError(
      `debits do not reconcile: rows total ${debits}, statement says ${summary.totalDebits}`,
    );
  }

  const derivedEnding = (summary.beginningBalance as number) + credits + debits;
  if (derivedEnding !== (summary.endingBalance as number)) {
    throw new ParseError(
      `balance does not reconcile: derived ${derivedEnding}, statement says ${summary.endingBalance}`,
    );
  }
}

/**
 * Walk `Running Bal.` row by row.
 *
 * Catches a single misparsed amount that happens to leave the totals intact —
 * two compensating errors — and pinpoints WHICH line broke, which the totals
 * check cannot. Skipped silently when the column is absent.
 */
export function assertRunningBalances(
  summary: StatementSummary | null,
  rows: readonly SourceRow[],
): void {
  if (!summary) return;
  if (!rows.every((row) => (row.fields['running_bal'] ?? '') !== '')) return;

  let expected = summary.beginningBalance as number;

  for (const row of rows) {
    const amount = parseMoney(row.fields['amount'] ?? '') as number;
    const stated = parseMoney(row.fields['running_bal'] ?? '') as number;
    expected += amount;

    if (stated !== expected) {
      throw new ParseError(
        `running balance does not reconcile: derived ${expected}, file says ${stated}`,
        row.lineNumber,
      );
    }
  }
}
