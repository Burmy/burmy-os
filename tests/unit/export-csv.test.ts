import { describe, expect, it } from 'vitest';

import {
  buildTransactionsCsv,
  humanizeEnum,
  LEDGER_CSV_HEADER,
  type LedgerExportRow,
  sanitizeCsvCell,
} from '@/server/finance/export/csv';

function row(overrides: Partial<LedgerExportRow> = {}): LedgerExportRow {
  return {
    transactionDate: '2026-05-14',
    normalizedMerchant: 'H-E-B',
    originalDescription: 'HEB #123 SPRINGFIELD TX',
    amountCents: 5914,
    categoryName: 'Food',
    transactionTypeLabel: 'Expense',
    reviewStatusLabel: 'Confirmed',
    categorizationSourceLabel: 'Manual',
    typeSourceLabel: 'Default',
    ...overrides,
  };
}

describe('sanitizeCsvCell', () => {
  it.each([
    ['=SUM(A1:A9)', "'=SUM(A1:A9)"],
    ['+1234', "'+1234"],
    ['-1234', "'-1234"],
    ['@SUM(1)', "'@SUM(1)"],
    ['  =cmd', "'  =cmd"],
  ])('prefixes a dangerous leading character: %s', (input, expected) => {
    expect(sanitizeCsvCell(input)).toBe(expected);
  });

  it.each(['H-E-B', 'VIA 313', 'Planet Fitness', "LARSEN'S #0366", ''])(
    'leaves ordinary text untouched: %s',
    (input) => {
      expect(sanitizeCsvCell(input)).toBe(input);
    },
  );
});

describe('buildTransactionsCsv', () => {
  it('emits the documented header, including the sign-convention note', () => {
    const csv = buildTransactionsCsv([]);
    const [header] = csv.split('\r\n');
    // The Amount header itself contains a comma ("USD, + = outflow"), so RFC
    // 4180 quoting applies to it same as any other field — asserted via the
    // other columns plus a substring check, rather than a raw `.join(',')`
    // that would ignore quoting.
    expect(header).toContain('Transaction Date,Normalized Merchant');
    expect(header).toContain('"Amount (USD, + = outflow)"');
    expect(header).toContain(',Category,Transaction Type,Review Status,Categorization Source,Type Source');
  });

  it('renders a normal row with every column in order', () => {
    const csv = buildTransactionsCsv([row()]);
    const lines = csv.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      '2026-05-14,H-E-B,HEB #123 SPRINGFIELD TX,59.14,Food,Expense,Confirmed,Manual,Default',
    );
  });

  it('formats a negative (inflow) amount as a plain signed decimal, never quoted as a formula', () => {
    const csv = buildTransactionsCsv([row({ amountCents: -3000 })]);
    expect(csv).toContain(',-30.00,');
    expect(csv).not.toContain("'-30.00");
  });

  it('sanitizes free-text fields that could be interpreted as formulas', () => {
    // No embedded quotes/commas here on purpose — RFC 4180 quoting is
    // covered by its own test below; this one isolates the injection guard.
    const csv = buildTransactionsCsv([
      row({
        normalizedMerchant: '=HYPERLINK(evil.example)',
        originalDescription: '+1 234 SOMETHING',
        categoryName: '@Category',
      }),
    ]);
    expect(csv).toContain("'=HYPERLINK(evil.example)");
    expect(csv).toContain("'+1 234 SOMETHING");
    expect(csv).toContain("'@Category");
  });

  it('never sanitizes the amount column, so negative amounts stay usable as numbers', () => {
    const csv = buildTransactionsCsv([row({ amountCents: -123456 })]);
    const [, dataLine] = csv.split('\r\n');
    const cells = dataLine!.split(',');
    // Amount is the 4th column (index 3).
    expect(cells[3]).toBe('-1234.56');
  });

  it('quotes a field containing a comma and doubles embedded quotes (RFC 4180)', () => {
    const csv = buildTransactionsCsv([
      row({ originalDescription: 'ACME, INC "PAYMENT"', normalizedMerchant: null }),
    ]);
    expect(csv).toContain('"ACME, INC ""PAYMENT"""');
  });

  it('renders null optional fields as empty cells, not the literal "null"', () => {
    const csv = buildTransactionsCsv([
      row({ normalizedMerchant: null, categoryName: null, categorizationSourceLabel: null }),
    ]);
    const [, dataLine] = csv.split('\r\n');
    const cells = dataLine!.split(',');
    expect(cells).toEqual([
      '2026-05-14',
      '', // normalized merchant
      'HEB #123 SPRINGFIELD TX',
      '59.14',
      '', // category
      'Expense',
      'Confirmed',
      '', // categorization source
      'Default',
    ]);
  });

  it('every data row parses back to the same field count as the header', () => {
    const csv = buildTransactionsCsv([row(), row({ originalDescription: 'A, B, C' })]);
    const lines = csv.split('\r\n').filter(Boolean);
    for (const line of lines) {
      // A crude but sufficient check given none of the fixtures nest quotes
      // inside quotes: every unescaped comma should yield the same column
      // count as the header once quoted commas are removed first.
      const withoutQuoted = line.replace(/"[^"]*"/g, 'X');
      expect(withoutQuoted.split(',').length).toBe(LEDGER_CSV_HEADER.length);
    }
  });
});

describe('humanizeEnum', () => {
  it.each([
    ['merchant_memory', 'Merchant Memory'],
    ['needs_review', 'Needs Review'],
    ['manual_confirmation', 'Manual Confirmation'],
    ['default', 'Default'],
    ['auto', 'Auto'],
  ])('%s -> %s', (input, expected) => {
    expect(humanizeEnum(input)).toBe(expected);
  });
});
