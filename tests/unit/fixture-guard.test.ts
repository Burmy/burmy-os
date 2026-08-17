import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

/**
 * GUARD: no committed fixture may contain real financial data.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS TEST EXISTS
 *
 * `.gitignore` blocks `*.csv` repo-wide and then force-unignores
 * `tests/fixtures/**` so the corpus is committable. That makes this directory the
 * ONE place in the repository where a real bank statement would be committed
 * silently — no warning, no diff review that catches it, and scrubbing it out of
 * git history afterwards is the expensive mistake the whole `.gitignore` exists to
 * prevent.
 *
 * M4 also amended the invariant: fixtures used to be "synthetic only", and are now
 * "redacted from real exports" because a parser must be tested against real quirks.
 * Redaction replaced synthesis as the safety property — so redaction needs a test.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const FIXTURES = path.resolve(process.cwd(), 'tests/fixtures/finance');

interface Fixture {
  readonly name: string;
  readonly text: string;
}

let fixtures: Fixture[] = [];

beforeAll(async () => {
  const names = (await readdir(FIXTURES)).filter((name) => name.endsWith('.csv'));
  fixtures = await Promise.all(
    names.map(async (name) => ({
      name,
      text: await readFile(path.join(FIXTURES, name), 'utf8'),
    })),
  );
});

describe('the corpus exists and is being checked', () => {
  it('found fixtures to check', () => {
    // A walker that silently found nothing would make every assertion below
    // vacuously true — the exact failure mode this whole file guards against.
    expect(fixtures.length).toBeGreaterThanOrEqual(8);
  });
});

describe('no fixture contains a card number', () => {
  /**
   * Luhn, applied only to ISOLATED runs of card length.
   *
   * The first version of this guard flagged any 13-19 digit run and was wrong: BoA
   * deposit descriptions legitimately carry ACH trace ids (`ID:8814027745219`) and
   * card exports carry 23-digit reference numbers, so it was red on correct data.
   * A permanently red guard gets ignored, and an ignored guard is worse than none.
   *
   * What actually identifies a card number is length (15-16) plus a valid Luhn
   * checksum, on a run that is not part of a longer number. Runs prefixed with
   * `ID:` are excluded because that is exactly how BoA labels an ACH trace id.
   */
  const luhn = (digits: string): boolean => {
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i -= 1) {
      let value = Number(digits[i]);
      if (double) {
        value *= 2;
        if (value > 9) value -= 9;
      }
      sum += value;
      double = !double;
    }
    return sum % 10 === 0;
  };

  it('has no isolated, Luhn-valid run of card length', () => {
    const offenders: string[] = [];

    for (const { name, text } of fixtures) {
      for (const match of text.matchAll(/\d{15,16}/g)) {
        const start = match.index;
        const end = start + match[0].length;

        // Part of a longer digit sequence (e.g. inside a 23-digit reference
        // number) — not a card number, and Luhn on a slice of one is meaningless.
        if (/\d/.test(text[start - 1] ?? '') || /\d/.test(text[end] ?? '')) continue;

        // An ACH trace id, which BoA labels explicitly.
        if (text.slice(Math.max(0, start - 3), start) === 'ID:') continue;

        if (luhn(match[0])) offenders.push(`${name}: isolated Luhn-valid ${match[0].length}-digit run`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('detects a real card number, so the guard is not vacuous', () => {
    // 4111111111111111 is the standard Visa test number and passes Luhn. If this
    // assertion ever fails, the guard above has stopped working and would let a
    // real card number through silently.
    expect(luhn('4111111111111111')).toBe(true);
    expect(luhn('4111111111111112')).toBe(false);
  });

  it('has no 9-digit run formatted like a social security number', () => {
    // The word boundaries here are `\b`. Written via a generator once, they came
    // out as literal 0x08 BACKSPACE bytes — a regex that matched nothing and looked
    // correct. Caught by ESLint's `no-control-regex`, which is the second time in
    // this project an invisible character has hidden inside a regex (see the
    // U+00A0 incident in money.ts).
    const SSN_SHAPED = /\b\d{3}-\d{2}-\d{4}\b/;

    const offenders = fixtures
      .filter(({ text }) => SSN_SHAPED.test(text))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });
});

describe('the redaction actually happened', () => {
  it('contains none of the real identifiers the source exports carried', () => {
    /**
     * A short denylist of values from the REAL exports, kept here because their
     * absence is the assertion. If a raw file were ever dropped into this
     * directory, these are what would appear.
     *
     * Deliberately not exhaustive — it cannot be, and a long list of real values
     * living in the repository would defeat its own purpose. It catches the
     * realistic accident: someone copies the original file in.
     */
    const mustNotAppear = [
      // Account fragments from the real exports.
      'SAV 1873',
      'CRD 8167',
      'CHK 7045',
      // The real account holder.
      'BURMY',
      'ANMOL',
      // The real payroll originator.
      'COGNIZANT',
    ];

    const offenders: string[] = [];
    for (const { name, text } of fixtures) {
      const upper = text.toUpperCase();
      for (const needle of mustNotAppear) {
        if (upper.includes(needle.toUpperCase())) offenders.push(`${name} contains "${needle}"`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('kept the structural quirks that make the corpus worth having', () => {
    // Redaction that also flattened the format would leave fixtures that prove
    // nothing. These are the characteristics the real files had.
    const deposit = fixtures.find((f) => f.name === 'boa-deposit-2026-05.csv');
    const card = fixtures.find((f) => f.name === 'boa-card-2026-05.csv');

    expect(deposit).toBeDefined();
    expect(card).toBeDefined();

    // Preamble with its own header, then a blank line, then the real header.
    expect(deposit!.text).toContain('Description,,Summary Amt.');
    expect(deposit!.text).toContain('Date,Description,Amount,Running Bal.');
    expect(deposit!.text).toMatch(/\n\r?\nDate,Description/);

    // The balance pseudo-row with an EMPTY amount.
    expect(deposit!.text).toMatch(/Beginning balance as of [^,]+,,"/);

    // Quoted amounts with thousands separators, and a comma inside a quoted field.
    expect(deposit!.text).toMatch(/"-?\d,\d{3}\.\d{2}"/);
    expect(deposit!.text).toContain('DOE,JORDAN');

    // An apostrophe and a semicolon inside descriptions.
    expect(deposit!.text).toContain("LARSEN'S");
    expect(deposit!.text).toContain('Payment;');

    // Card: fused city/state, a truncated payee with no spaces, and the
    // fixed-width padded address with its trailing space.
    expect(card!.text).toContain('BAY HARBOURCA');
    expect(card!.text).toContain('Sunset ValleyTX');
    expect(card!.text).toContain('WESTBROOKANIMALCLINICS');
    expect(card!.text).toContain('"SPRINGFIELD   TX "');

    // Processor prefixes.
    for (const prefix of ['TST*', 'SQ *', 'NPO* ', 'YSI*', 'PADDLE.NET* ']) {
      expect(card!.text, prefix).toContain(prefix);
    }
  });

  it('preserved the cross-file confirmation linkage', () => {
    // The most valuable property in the corpus: both legs of a card payment carry
    // the same confirmation token. Substituting the two files independently would
    // have destroyed it silently, and M6's counterpart matching would have lost
    // its strongest test.
    const deposit = fixtures.find((f) => f.name === 'boa-deposit-2026-05.csv')!.text;
    const card = fixtures.find((f) => f.name === 'boa-card-2026-05.csv')!.text;

    const tokens = (text: string, pattern: RegExp): Set<string> =>
      new Set([...text.matchAll(pattern)].map((match) => match[1] ?? ''));

    const depositTokens = tokens(deposit, /Confirmation#\s*([a-z0-9]+)/gi);
    const cardTokens = tokens(card, /CONF#([a-z0-9]+)/gi);

    const shared = [...depositTokens].filter((token) => cardTokens.has(token));
    expect(shared.length).toBeGreaterThanOrEqual(2);
  });
});

describe('the corpus is checksummed', () => {
  it('matches the recorded digests, so an edit must be deliberate', () => {
    /**
     * Fixtures are the parser's ground truth. An accidental edit — an editor
     * normalizing line endings, a "helpful" formatter, a careless regenerate —
     * would silently change what every parser test asserts against.
     *
     * When a fixture SHOULD change, update the digest in the same commit. That
     * makes the change visible in review, which is the point.
     */
    const expected: Record<string, string> = {
      'boa-card-2026-05-crlf.csv': '390920d6240abc7b',
      'boa-card-2026-05.csv': 'bdf77bbf2d5ca702',
      'boa-card-all-inflows.csv': '9774d9d06644db07',
      'boa-card-thousands-quoted.csv': 'eb31d3492549e898',
      'boa-deposit-2026-05-bom.csv': 'd2fd8bce24880536',
      'boa-deposit-2026-05-crlf.csv': '000eeacbce8eeea4',
      'boa-deposit-2026-05.csv': '0cd680f57284a01c',
      'boa-deposit-totals-mismatch.csv': '5b69ba0e436e0558',
      'malformed.csv': 'f84991711e93801e',
      'unknown-headers.csv': '49c4a0ed672b72f8',
    };

    const actual = Object.fromEntries(
      fixtures.map(({ name, text }) => [
        name,
        createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16),
      ]),
    );

    expect(actual).toEqual(expected);
  });
});
