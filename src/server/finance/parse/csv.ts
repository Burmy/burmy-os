import Papa from 'papaparse';

import { ParseError } from './types';
import { hasAllColumns, normalizeHeaderName } from './signature';

/**
 * Raw bytes → rows of strings. No interpretation beyond splitting.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS TAKES BYTES AND NOT A STRING
 *
 * Because encoding and the byte-order mark are part of the problem. A caller that
 * has already decoded has already made a decision — and if it decoded with the
 * wrong assumption, a BOM survives as a zero-width character glued to the first
 * header cell, so `Date` never matches `date` and the whole file looks like an
 * unknown format. Taking bytes keeps that decision here, where it is tested.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** ≤50k rows. Beyond this a file is not a monthly statement. */
const MAX_ROWS = 50_000;

/** ≤4KB per cell. */
const MAX_CELL_LENGTH = 4096;

/**
 * Decode as UTF-8 and strip a leading BOM.
 *
 * `TextDecoder('utf-8')` does not remove U+FEFF; only the `ignoreBOM: false`
 * default *interprets* it, and Node's implementation still leaves it in place for
 * a stream decoded in one shot. Stripping explicitly is the reliable form, and it
 * is asserted by a fixture whose bytes begin with EF BB BF.
 */
function decodeUtf8(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8').decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export interface RawLines {
  /** Every physical line, in order, 0-based. */
  readonly rows: readonly string[][];
  /** `\r\n` or `\n`, as observed. Recorded because it is a format fingerprint. */
  readonly lineEnding: '\r\n' | '\n';
}

/**
 * Split the whole file into cells WITHOUT treating any row as a header.
 *
 * Papa Parse is asked for `header: false` on purpose. With `header: true` it takes
 * row ONE as the header, and a BoA deposit export's row one is
 * `Description,,Summary Amt.` — the summary block, not the transactions. Every
 * subsequent row would then be keyed by the wrong names and the transaction table
 * would parse as garbage that still looked structurally valid.
 */
export function splitCells(bytes: Uint8Array): RawLines {
  const text = decodeUtf8(bytes);
  const lineEnding = text.includes('\r\n') ? '\r\n' : '\n';

  const result = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: false,
    // Quotes must be honoured: descriptions contain commas ("DOE,JORDAN") and a
    // naive split would shift every following column.
    quoteChar: '"',
    escapeChar: '"',
  });

  // Papa reports quote problems as errors; a malformed quote can silently swallow
  // the rest of a file, so it fails rather than truncating.
  const fatal = result.errors.find((error) => error.type === 'Quotes');
  if (fatal) {
    throw new ParseError(`unterminated quoted field`, (fatal.row ?? 0) + 1);
  }

  const rows = result.data.map((row) => row.map((cell) => cell ?? ''));

  if (rows.length > MAX_ROWS) {
    throw new ParseError(`file has more than ${MAX_ROWS} rows`);
  }

  for (const [index, row] of rows.entries()) {
    for (const cell of row) {
      if (cell.length > MAX_CELL_LENGTH) {
        throw new ParseError(`a cell exceeds ${MAX_CELL_LENGTH} characters`, index + 1);
      }
    }
  }

  return { rows, lineEnding };
}

export interface HeaderLocation {
  /** 0-based index into `rows`. */
  readonly index: number;
  readonly headers: readonly string[];
}

/**
 * Find the row that is really the header.
 *
 * Scans for the FIRST row containing every required column, rather than assuming
 * position. That is what lets a deposit export carry five preamble lines and a
 * blank line above its real header — and what stops the summary block, which also
 * has a `Description` column, from being mistaken for it.
 *
 * Returns null when no row qualifies, so the caller can fall through to the
 * generic mapper instead of guessing.
 */
export function locateHeader(
  rows: readonly string[][],
  required: readonly string[],
): HeaderLocation | null {
  for (const [index, row] of rows.entries()) {
    if (row.length === 0) continue;
    if (hasAllColumns(row, required)) return { index, headers: row };
  }
  return null;
}

/**
 * Zip a data row against the header row.
 *
 * Ragged rows are NOT padded or truncated into shape. A row with the wrong column
 * count means the parse has lost alignment, and quietly filling the gap with an
 * empty string is how a shifted amount column becomes a plausible wrong number.
 */
export function zipRow(
  headers: readonly string[],
  row: readonly string[],
  lineNumber: number,
): Record<string, string> {
  if (row.length !== headers.length) {
    throw new ParseError(
      `expected ${headers.length} columns, found ${row.length}`,
      lineNumber,
    );
  }

  const fields: Record<string, string> = {};
  for (const [index, header] of headers.entries()) {
    const name = normalizeHeaderName(header);
    if (name === '') continue;
    fields[name] = (row[index] ?? '').trim();
  }
  return fields;
}
