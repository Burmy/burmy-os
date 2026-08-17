import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { assertCardHasOutflows } from '@/server/finance/adapters/boa-card';
import { assertDepositTotals, parseBoaDeposit } from '@/server/finance/adapters/boa-deposit';
import { detectFormat, parseStatement, parseStatementTolerant } from '@/server/finance/parse';
import { sourceAmounts } from '@/server/finance/parse/normalize';
import { ParseError } from '@/server/finance/parse/types';

/**
 * The BoA adapters, against the REAL fixture BYTES.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * These read the files from disk as `Uint8Array` and hand them to the parser
 * unmodified. Nothing here constructs a row object by hand.
 *
 * That is the whole point of the corpus. Hand-built inputs test the parser against
 * the author's mental model of BoA's format — which is precisely the thing M4
 * exists to stop trusting. The fixtures are redacted from real exports and keep
 * every structural quirk: the preamble with its own header, the blank line, the
 * balance pseudo-row with an empty amount, mixed quoting, commas inside quoted
 * fields, fused city/state, truncated payees, and descending row order.
 *
 * `docs/SECURITY.md` records what redaction preserves and what it substitutes.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const FIXTURES = path.resolve(process.cwd(), 'tests/fixtures/finance');

async function bytes(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path.join(FIXTURES, name)));
}

// The fixtures are dated May–June 2026; pin `now` so date-sanity assertions do
// not start failing a year from now for reasons unrelated to the parser.
const NOW = new Date('2026-06-15T00:00:00Z');

let deposit: Uint8Array;
let card: Uint8Array;

beforeAll(async () => {
  deposit = await bytes('boa-deposit-2026-05.csv');
  card = await bytes('boa-card-2026-05.csv');
});

describe('format detection', () => {
  it('identifies a deposit export despite five preamble lines above the header', async () => {
    // The naive read — `header: true` on row one — would take
    // `Description,,Summary Amt.` as the header and key every transaction wrong.
    expect(detectFormat(deposit).adapter).toBe('boa-deposit');
  });

  it('identifies a card export', () => {
    expect(detectFormat(card).adapter).toBe('boa-card');
  });

  it('does not use the filename', async () => {
    // The real card export was named for May and covered 04/28–05/27. Identical
    // bytes under any name must detect identically.
    const renamed = await bytes('boa-card-2026-05.csv');
    expect(detectFormat(renamed).adapter).toBe('boa-card');
  });

  it('gives the two formats different signatures', () => {
    expect(detectFormat(deposit).signature).not.toBe(detectFormat(card).signature);
  });

  it('gives a signature that survives a BOM and CRLF line endings', async () => {
    // A surviving BOM glues a zero-width character to the first header cell, so
    // `Date` never matches `date` and a known format looks unknown.
    const withBom = await bytes('boa-deposit-2026-05-bom.csv');
    const withCrlf = await bytes('boa-deposit-2026-05-crlf.csv');

    expect(detectFormat(withBom).signature).toBe(detectFormat(deposit).signature);
    expect(detectFormat(withCrlf).signature).toBe(detectFormat(deposit).signature);
  });

  it('reports an unknown layout as generic rather than mis-parsing it', async () => {
    const unknown = await bytes('unknown-headers.csv');
    const format = detectFormat(unknown);

    expect(format.adapter).toBe('generic');
    // Still gets a stable signature, so the mapping can be remembered in M5.
    expect(format.signature).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('BoA deposit export', () => {
  it('skips the preamble, the header and the balance pseudo-row', () => {
    const { result, candidates } = parseStatement(deposit, NOW);

    // 12 transactions in the fixture; the 13th dated row is the pseudo-row.
    expect(candidates).toHaveLength(12);

    const reasons = result.skipped.map((entry) => entry.reason);
    expect(reasons).toContain('preamble');
    expect(reasons).toContain('header');
    expect(reasons).toContain('balance-pseudo-row');
  });

  it('never imports the balance pseudo-row as a 0.00 transaction', () => {
    // It carries a date and a running balance but an EMPTY amount. Importing it
    // would put a phantom transaction on day one of every statement.
    const { candidates } = parseStatement(deposit, NOW);

    expect(candidates.some((c) => (c.amountCents as number) === 0)).toBe(false);
    expect(candidates.some((c) => /balance as of/i.test(c.originalDescription))).toBe(false);
  });

  it('INVERTS the sign: BoA negative becomes Burmy positive for an outflow', () => {
    // The single most consequential conversion in the parser. BoA writes a debit
    // as negative; Burmy stores an outflow as positive.
    const { candidates } = parseStatement(deposit, NOW);
    const transfer = candidates.find((c) => c.originalDescription.includes('transfer to SAV'));

    expect(transfer?.amountCents).toBe(54025);
    expect(transfer?.detectedDirection).toBe('outflow');

    const payroll = candidates.find((c) => c.originalDescription.includes('PAYROLL'));
    expect(payroll?.amountCents).toBe(-210540);
    expect(payroll?.detectedDirection).toBe('inflow');
  });

  it('parses quoted amounts with thousands separators', () => {
    const { candidates } = parseStatement(deposit, NOW);
    const large = candidates.find((c) => c.originalDescription.includes('scheduled transfer'));
    expect(large?.amountCents).toBe(125000);
  });

  it('honours quoting, so a comma inside a description does not shift columns', () => {
    // The payroll description contains "DOE,JORDAN". A naive split on commas
    // would move the amount into the description column and still look valid.
    const { candidates } = parseStatement(deposit, NOW);
    const payroll = candidates.find((c) => c.originalDescription.includes('PAYROLL'));

    expect(payroll?.originalDescription).toContain('DOE,JORDAN');
    expect(payroll?.amountCents).toBe(-210540);
  });

  it('retains the description VERBATIM, punctuation and all', () => {
    // It is the input to `dedupe_key` under a frozen algorithm, so any cleanup
    // here would change identity for every future import.
    const { candidates } = parseStatement(deposit, NOW);

    expect(candidates.some((c) => c.originalDescription.includes("LARSEN'S #0366"))).toBe(true);
    expect(candidates.some((c) => c.originalDescription.includes('Payment;'))).toBe(true);
  });

  it('keeps two same-day, same-amount rows as two transactions', () => {
    // Two -540.25 rows on 05/14 with different descriptions. Tier 2 count
    // reconciliation depends on these surviving as separate candidates.
    const { candidates } = parseStatement(deposit, NOW);
    const sameDay = candidates.filter(
      (c) => c.transactionDate === '2026-05-14' && (c.amountCents as number) === 54025,
    );

    expect(sameDay).toHaveLength(2);
    expect(new Set(sameDay.map((c) => c.originalDescription)).size).toBe(2);
  });

  it('converts dates to calendar days, not timestamps', () => {
    const { candidates } = parseStatement(deposit, NOW);
    expect(candidates[0]?.transactionDate).toBe('2026-05-14');
    for (const candidate of candidates) {
      expect(candidate.transactionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('leaves postedDate null when the format has one date column', () => {
    const { candidates } = parseStatement(deposit, NOW);
    expect(candidates.every((c) => c.postedDate === null)).toBe(true);
  });

  it('captures no source identifier, because this format provides none', () => {
    const { candidates } = parseStatement(deposit, NOW);
    expect(candidates.every((c) => c.sourceTransactionId === null)).toBe(true);
  });

  it('parses identically from CRLF and BOM variants', async () => {
    const plain = parseStatement(deposit, NOW).candidates;
    const crlf = parseStatement(await bytes('boa-deposit-2026-05-crlf.csv'), NOW).candidates;
    const bom = parseStatement(await bytes('boa-deposit-2026-05-bom.csv'), NOW).candidates;

    expect(crlf).toEqual(plain);
    expect(bom).toEqual(plain);
  });
});

describe('BoA deposit: the statement reconciles to itself', () => {
  it('reads the summary block', () => {
    const result = parseBoaDeposit(deposit);
    expect(result.summary).not.toBeNull();
    expect(result.summary?.beginningBalance).toBe(1045000);
  });

  it('reconciles credits, debits and the ending balance to the cent', () => {
    // Verified against the real export before redaction, and preserved by
    // recomputing the totals after substitution. This is the strongest
    // correctness signal the project has: it keeps working on unseen data.
    const result = parseBoaDeposit(deposit);
    const amounts = sourceAmounts(result, 'amount');

    expect(() => assertDepositTotals(result.summary!, amounts)).not.toThrow();

    const credits = amounts.filter((v) => v > 0).reduce((a, b) => a + b, 0);
    const debits = amounts.filter((v) => v < 0).reduce((a, b) => a + b, 0);
    expect(credits).toBe(result.summary?.totalCredits);
    expect(debits).toBe(result.summary?.totalDebits);
    expect((result.summary!.beginningBalance as number) + credits + debits).toBe(
      result.summary?.endingBalance,
    );
  });

  it('FAILS LOUDLY when the rows do not match the stated totals', async () => {
    // A dropped row, an inverted sign, or a comma eaten by a bad split all land
    // here rather than producing a total that is quietly wrong.
    const broken = await bytes('boa-deposit-totals-mismatch.csv');
    expect(() => parseStatement(broken, NOW)).toThrow(ParseError);
    expect(() => parseStatement(broken, NOW)).toThrow(/do not reconcile/i);
  });

  it('walks every Running Bal. row by row', () => {
    // Catches a single misparsed amount that two compensating errors would hide
    // from the totals check, and names the offending line.
    expect(() => parseStatement(deposit, NOW)).not.toThrow();
  });
});

describe('BoA card export', () => {
  it('parses every row from a header on line one', () => {
    const { candidates } = parseStatement(card, NOW);
    expect(candidates).toHaveLength(40);
  });

  it('inverts the sign for purchases and payments alike', () => {
    const { candidates } = parseStatement(card, NOW);

    const purchase = candidates.find((c) => c.originalDescription.includes('WESTBROOK'));
    expect(purchase?.amountCents).toBe(2865);
    expect(purchase?.detectedDirection).toBe('outflow');

    const payment = candidates.find((c) => c.originalDescription.includes('PAYMENT FROM CHK'));
    expect((payment?.amountCents as number) < 0).toBe(true);
    expect(payment?.detectedDirection).toBe('inflow');
  });

  it('uses the single Posted Date for BOTH dates', () => {
    // This format provides no transaction date. `transaction_date` is NOT NULL and
    // the grid buckets on it, so the posted date populates both — recorded as a
    // source limitation rather than invented data.
    const { candidates } = parseStatement(card, NOW);

    for (const candidate of candidates) {
      expect(candidate.postedDate).toBe(candidate.transactionDate);
    }
  });

  it('captures Reference Number as ADVISORY metadata', () => {
    // Present on every row, including payments. Captured so the Tier 1
    // verification is a later comparison rather than a parser rewrite — but
    // nothing depends on it, because cross-export stability is unverified.
    const { candidates } = parseStatement(card, NOW);

    expect(candidates.every((c) => c.sourceTransactionId !== null)).toBe(true);
    expect(candidates.every((c) => /^\d{23}$/.test(c.sourceTransactionId ?? ''))).toBe(true);
  });

  it('observes that Reference Numbers are unique WITHIN this sample', () => {
    // Coverage and in-file uniqueness are the two Tier 1 checks the available
    // sample can answer. Stability across exports is the one it cannot, so no
    // unique constraint exists. See docs/FINANCE.md.
    const { candidates } = parseStatement(card, NOW);
    const ids = candidates.map((c) => c.sourceTransactionId);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('discards the Address column entirely', () => {
    // Plan §18 keeps address fragments out of a table that lives for 60 days.
    const { candidates } = parseStatement(card, NOW);
    const serialized = JSON.stringify(candidates);

    // The padded address form appears nowhere in the normalized output.
    expect(serialized).not.toContain('SPRINGFIELD   TX');
    for (const candidate of candidates) {
      expect(Object.keys(candidate)).not.toContain('address');
    }
  });

  it('does not assume row order — this export is strictly DESCENDING', () => {
    // The deposit export is ascending, the card export descending. Asserting the
    // whole sequence rather than two endpoints, so a fixture edit that quietly
    // breaks the ordering characteristic fails here.
    const { candidates } = parseStatement(card, NOW);
    const dates = candidates.map((c) => c.transactionDate);

    expect(dates[0]).toBe('2026-05-28');
    expect(dates.at(-1)).toBe('2026-04-28');
    expect([...dates].sort().reverse()).toEqual(dates);

    // ...while the deposit export is strictly ascending.
    const depositDates = parseStatement(deposit, NOW).candidates.map((c) => c.transactionDate);
    expect([...depositDates].sort()).toEqual(depositDates);
  });

  it('preserves truncated payees and fused city/state verbatim', () => {
    // BoA truncates the payee to ~22 characters and sometimes fuses the state
    // onto the city with no separator. Merchant normalization has to cope; the
    // parser must not "fix" it, because the description feeds `dedupe_key`.
    const { candidates } = parseStatement(card, NOW);
    const descriptions = candidates.map((c) => c.originalDescription);

    expect(descriptions.some((d) => d.includes('BAY HARBOURCA'))).toBe(true);
    expect(descriptions.some((d) => d.includes('Sunset ValleyTX'))).toBe(true);
    expect(descriptions.some((d) => d === 'WESTBROOKANIMALCLINICS SPRINGFIELD TX')).toBe(true);
  });

  it('accepts four-figure amounts with and without a thousands separator', async () => {
    // No amount in the real sample reached four figures, so this behaviour is an
    // ASSUMPTION. Both forms are accepted so whichever BoA emits, it parses.
    const plain = parseStatement(card, NOW).candidates;
    const quoted = parseStatement(await bytes('boa-card-thousands-quoted.csv'), NOW).candidates;

    const findLarge = (list: typeof plain) =>
      list.find((c) => c.originalDescription.includes('ALPINE'));

    expect(findLarge(plain)?.amountCents).toBe(184230);
    expect(findLarge(quoted)?.amountCents).toBe(184230);
  });

  it('REFUSES a card export in which every row is an inflow', async () => {
    // The loud failure plan §22 requires. A card statement cannot look like this,
    // and inverting a month of spending silently is the alternative.
    const inverted = await bytes('boa-card-all-inflows.csv');
    expect(() => parseStatement(inverted, NOW)).toThrow(ParseError);
    expect(() => parseStatement(inverted, NOW)).toThrow(/sign convention/i);
  });

  it('allows an all-OUTFLOW card export, which is perfectly normal', () => {
    // A month of purchases with no payment. Asserting both directions would
    // reject real files.
    expect(() => assertCardHasOutflows([-100, -200, -300])).not.toThrow();
  });
});

describe('the two files agree with each other', () => {
  it('links both legs of a card payment by confirmation number', () => {
    /**
     * The most valuable property in the corpus, and it only showed up in real
     * data: the checking leg carries `Confirmation# <token>` and the card leg
     * carries `CONF#<token>` — the SAME token, opposite signs, a day apart.
     *
     * Plan §24 designed a qualified counterpart match as structural conditions
     * plus a recognized keyword plus uniqueness. A shared confirmation number is
     * far stronger: effectively one transaction id present on both legs.
     *
     * M4 only PRESERVES it — extracting and matching is M6's job, and doing it
     * here would put classification inside the parser. This test exists so the
     * property cannot be lost by a future "tidy up the description" change.
     */
    const depositCandidates = parseStatement(deposit, NOW).candidates;
    const cardCandidates = parseStatement(card, NOW).candidates;

    const token = (text: string): string | null =>
      /(?:Confirmation#|CONF#)\s*([a-z0-9]+)/i.exec(text)?.[1] ?? null;

    const cardPaymentTokens = new Set(
      cardCandidates
        .filter((c) => c.originalDescription.startsWith('PAYMENT FROM CHK'))
        .map((c) => token(c.originalDescription))
        .filter((value): value is string => value !== null),
    );

    const matched = depositCandidates.filter((c) => {
      const value = token(c.originalDescription);
      return value !== null && cardPaymentTokens.has(value);
    });

    expect(matched.length).toBeGreaterThanOrEqual(2);

    // ...and the matched legs are equal and opposite.
    for (const leg of matched) {
      const value = token(leg.originalDescription);
      const counterpart = cardCandidates.find(
        (c) => token(c.originalDescription) === value && c.originalDescription.includes('PAYMENT'),
      );
      expect(counterpart).toBeDefined();
      expect(leg.amountCents).toBe(-(counterpart!.amountCents as number));
    }
  });

  it('tolerates a leg with no counterpart in the batch', () => {
    // One payment postdates the card statement; another predates the checking
    // window. An unmatched leg is NORMAL, not an error — which is why matching
    // needs a ±7 day window and multi-file batches, and why an unmatched
    // suspicion must produce a review item rather than an exclusion.
    const depositCandidates = parseStatement(deposit, NOW).candidates;
    const cardCandidates = parseStatement(card, NOW).candidates;

    const cardPayments = cardCandidates.filter((c) =>
      c.originalDescription.startsWith('PAYMENT FROM CHK'),
    );
    const depositPayments = depositCandidates.filter((c) =>
      c.originalDescription.includes('payment to CRD'),
    );

    expect(depositPayments.length).toBeGreaterThan(cardPayments.length - 1);
    expect(cardPayments.length).toBe(3);
    expect(depositPayments.length).toBe(3);
  });
});

describe('malformed input fails loudly', () => {
  it('rejects a row with the wrong column count rather than padding it', async () => {
    // Padding a short row would let a shifted amount column become a plausible
    // wrong number.
    const malformed = await bytes('malformed.csv');
    expect(() => parseBoaDeposit(malformed)).toThrow(ParseError);
    expect(() => parseBoaDeposit(malformed)).toThrow(/expected 4 columns/);
  });

  it('names the LINE, never the row content', async () => {
    // Errors must not put statement text into logs. Plan §14: a row NUMBER, never
    // row content.
    const malformed = await bytes('malformed.csv');
    try {
      parseBoaDeposit(malformed);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      const message = (error as ParseError).message;
      expect(message).toMatch(/^line \d+:/);
      expect(message).not.toContain('Too few columns');
    }
  });
});

describe('parseStatementTolerant — one bad row does not abort the file', () => {
  // Hand-built, deliberately — unlike the adapter suites above, this is testing
  // M5's generic collect-instead-of-throw control flow, not BoA's real shape,
  // so it does not need the redacted corpus.
  function cardCsv(rows: string): Uint8Array {
    return new TextEncoder().encode(`Posted Date,Reference Number,Payee,Address,Amount\n${rows}`);
  }

  it('collects a per-row normalize failure instead of throwing', () => {
    const bytesWithOneBadRow = cardCsv(
      '05/01/2026,REF1,GOOD MERCHANT,,-10.00\n' +
        '13/45/2026,REF2,BAD DATE ROW,,-20.00\n' +
        '05/03/2026,REF3,ANOTHER GOOD ONE,,-5.00\n',
    );

    const result = parseStatementTolerant(bytesWithOneBadRow, NOW);

    expect(result.candidates.map((c) => c.originalDescription)).toEqual([
      'GOOD MERCHANT',
      'ANOTHER GOOD ONE',
    ]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.lineNumber).toBe(3);
    expect(result.failures[0]?.message).toMatch(/impossible date/);
  });

  it('still throws for a FILE-level structural failure — the all-inflow guard', () => {
    // Row-level tolerance must never mask a whole-file integrity problem: the
    // deposit checksum, the running balance, and this all-inflow guard all stay
    // hard failures, exactly as in `parseStatement`.
    const allInflow = cardCsv('05/01/2026,REF1,REFUND,,10.00\n');
    expect(() => parseStatementTolerant(allInflow, NOW)).toThrow(ParseError);
  });

  it('produces the identical result to parseStatement when nothing fails', () => {
    // `parseStatement()` itself is untouched — same detection, same assertions,
    // same candidates — this only proves the refactor that shares that logic
    // did not change its behaviour.
    const tolerant = parseStatementTolerant(card, NOW);
    const strict = parseStatement(card, NOW);

    expect(tolerant.candidates).toEqual(strict.candidates);
    expect(tolerant.format).toEqual(strict.format);
    expect(tolerant.failures).toEqual([]);
  });
});
