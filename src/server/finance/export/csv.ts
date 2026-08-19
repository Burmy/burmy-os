/**
 * M9's transaction ledger export — CSV only, hand-rolled RFC 4180 quoting plus
 * a formula-injection guard. Pure and framework-free, like the rest of
 * `src/server/finance/`: no DB, no Next.js, no HTTP. The caller (a Route
 * Handler) supplies already-resolved, already-labeled rows; this module only
 * decides how to render them safely as CSV text.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FORMULA INJECTION
 *
 * A cell opened in Excel/Sheets that STARTS with `=`, `+`, `-` or `@` can
 * execute as a formula (OWASP CSV Injection). Every free-text field that
 * ultimately comes from a bank statement or the owner's own typing (merchant,
 * raw description, category name) is sanitized.
 *
 * The Amount column is deliberately EXEMPT: it is produced entirely by
 * `toDecimalString()` below, never by statement or owner text, so it cannot
 * carry an injected payload — and blanket-sanitizing it would prefix every
 * negative amount with `'`, breaking the column as a number in the exact file
 * this feature exists to produce. Same reasoning for the date and the fixed
 * label columns (type/status/source): closed vocabularies the app controls.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { cents, toDecimalString } from '@/server/finance/money';

const DANGEROUS_LEADING_CHARS = new Set(['=', '+', '-', '@']);

/** Neutralize a free-text cell that could be interpreted as a formula. */
export function sanitizeCsvCell(value: string): string {
  const firstChar = value.trimStart().charAt(0);
  if (firstChar && DANGEROUS_LEADING_CHARS.has(firstChar)) return `'${value}`;
  return value;
}

/** RFC 4180: quote a field containing a comma, quote, or newline; double any embedded quotes. */
function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export const LEDGER_CSV_HEADER = [
  'Transaction Date',
  'Normalized Merchant',
  'Raw Description',
  'Amount (USD, + = outflow)',
  'Category',
  'Transaction Type',
  'Review Status',
  'Categorization Source',
  'Type Source',
] as const;

export interface LedgerExportRow {
  readonly transactionDate: string;
  readonly normalizedMerchant: string | null;
  readonly originalDescription: string;
  /** Signed cents, positive = outflow — same convention as everywhere else in the app. */
  readonly amountCents: number;
  readonly categoryName: string | null;
  readonly transactionTypeLabel: string;
  readonly reviewStatusLabel: string;
  readonly categorizationSourceLabel: string | null;
  readonly typeSourceLabel: string;
}

function buildRow(row: LedgerExportRow): string {
  const fields = [
    row.transactionDate,
    sanitizeCsvCell(row.normalizedMerchant ?? ''),
    sanitizeCsvCell(row.originalDescription),
    toDecimalString(cents(row.amountCents)),
    sanitizeCsvCell(row.categoryName ?? ''),
    row.transactionTypeLabel,
    row.reviewStatusLabel,
    row.categorizationSourceLabel ?? '',
    row.typeSourceLabel,
  ];
  return fields.map(escapeCsvField).join(',');
}

/** Header + one line per row, CRLF-terminated per RFC 4180. */
export function buildTransactionsCsv(rows: readonly LedgerExportRow[]): string {
  const lines = [LEDGER_CSV_HEADER.map(escapeCsvField).join(',')];
  for (const row of rows) lines.push(buildRow(row));
  return `${lines.join('\r\n')}\r\n`;
}

/** `merchant_memory` -> `Merchant Memory`. For the enum-shaped provenance columns, which have no display dictionary of their own yet. */
export function humanizeEnum(value: string): string {
  return value
    .split('_')
    .map((word) => (word.length > 0 ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(' ');
}
