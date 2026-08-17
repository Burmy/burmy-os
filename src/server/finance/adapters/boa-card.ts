import { locateHeader, splitCells, zipRow } from '@/server/finance/parse/csv';
import { ADAPTER_COLUMNS, headerSignature } from '@/server/finance/parse/signature';
import {
  ParseError,
  type ParseResult,
  type SkippedLine,
  type SourceRow,
} from '@/server/finance/parse/types';

/**
 * Bank of America credit-card export.
 *
 * OBSERVED SHAPE — from a real export read during M4:
 *
 *   Posted Date,Reference Number,Payee,Address,Amount
 *   05/27/2026,41802577390112004886317,"WESTBROOK… SPRINGFIELD TX","SPRINGFIELD   TX ",-28.65
 *   05/19/2026,24031512161155316444736,"PAYMENT FROM CHK 2288 CONF#4p9dnrwz6","",88.15
 *
 * Differences from the deposit export that matter:
 *
 *   · Header on line 1. No preamble, and therefore NO summary block and no
 *     reconcilable checksum — the deposit export's strongest guarantee is simply
 *     unavailable here.
 *   · ONE date only, labelled `Posted Date`. There is no transaction date.
 *   · Amounts are UNQUOTED with no thousands separator in the sample. No value
 *     reached four figures, so behaviour above 999.99 is UNVERIFIED — `parseMoney`
 *     accepts both forms and fixtures cover each.
 *   · Rows are in DESCENDING date order, the opposite of the deposit export. No
 *     stage may assume input ordering.
 *   · `Address` is city left-justified in 14 columns, then the state, then a
 *     trailing space. Empty on payment rows.
 *
 * DISCARDED AT PARSE: `Address` is never persisted. Plan §18 removes the raw blob
 * from staging precisely so that address fragments do not sit in a table that
 * lives for 60 days, and re-introducing it through a mapped column would defeat
 * that.
 */

export const BOA_CARD_ADAPTER = 'boa-card' as const;

/** A purchase is negative here too. Burmy's convention is the inverse. */
export const BOA_CARD_SIGN = 'negative-is-outflow' as const;

export function parseBoaCard(bytes: Uint8Array): ParseResult {
  const { rows } = splitCells(bytes);

  const header = locateHeader(rows, ADAPTER_COLUMNS['boa-card']);
  if (!header) {
    throw new ParseError('no row contains the columns a BoA card export requires');
  }

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
    if (row.length === 0 || (row.length === 1 && (row[0] ?? '').trim() === '')) {
      skipped.push({ lineNumber, reason: 'blank-line' });
      continue;
    }

    const fields = zipRow(header.headers, row, lineNumber);

    if ((fields['amount'] ?? '') === '') {
      skipped.push({ lineNumber, reason: 'no-amount' });
      continue;
    }

    parsed.push({ lineNumber, fields });
  }

  return {
    adapter: BOA_CARD_ADAPTER,
    signature: headerSignature(header.headers),
    rows: parsed,
    skipped,
    // No summary block exists in this format.
    summary: null,
  };
}

/**
 * A card statement of nothing but inflows is the signature of an inverted parse.
 *
 * This is the loud failure plan §22 asks for. The deposit export gets a far
 * stronger guarantee from its summary block; a card export has no arithmetic to
 * check against, so this is the available assertion.
 *
 * It is deliberately weak in one direction: an all-OUTFLOW card statement is
 * perfectly normal (a month with purchases and no payment), so only the
 * all-inflow case fails. Asserting both directions would reject real files.
 *
 * @throws ParseError
 */
export function assertCardHasOutflows(sourceAmounts: readonly number[]): void {
  if (sourceAmounts.length === 0) return;

  const outflows = sourceAmounts.filter((value) => value < 0).length;
  if (outflows === 0) {
    throw new ParseError(
      'every row in this card export is an inflow, which means the sign convention ' +
        'is not what this adapter expects — refusing rather than inverting a month of spending',
    );
  }
}
