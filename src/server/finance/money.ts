/**
 * Money — the single source of monetary arithmetic in Burmy.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULES. Read these before changing anything in this file.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. Money is a signed integer count of MINOR UNITS (cents). Never a float.
 *
 * 2. POSITIVE = OUTFLOW (money leaving the owner). Negative = inflow.
 *
 *    This is not the bank's convention, and it is not arbitrary. It falls out of
 *    a hard product requirement: a reimbursement must REDUCE its category.
 *
 *        Food — August
 *          Velvet Taco        +6000
 *          Zelle from Alex    -3000     <- reimbursement, SAME category
 *          H-E-B              +5914
 *          ------------------------
 *          SUM                 8914  ->  $89.14
 *
 *    A plain SUM() produces the right answer with no special cases anywhere in
 *    the reporting layer. Adapters are responsible for translating each bank's
 *    convention into this one; this module is convention-agnostic when parsing.
 *
 * 3. We do NOT use PostgreSQL NUMERIC. The `pg` driver returns NUMERIC as a
 *    STRING to preserve precision, so every aggregate would need parsing at the
 *    boundary — and the obvious `parseFloat` reintroduces exactly the
 *    floating-point bug we are avoiding. BIGINT cents sidesteps this entirely.
 *
 * 4. Cents fit Number.MAX_SAFE_INTEGER up to ~$90 trillion, so a plain JS
 *    `number` is safe here without BigInt ergonomics. `assertSafe` enforces it.
 *
 * 5. NOTHING ELSE IN THE CODEBASE DOES MONEY ARITHMETIC. If you find yourself
 *    writing `a + b` on two money values outside this file, stop.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Branded type
// ─────────────────────────────────────────────────────────────────────────────

declare const centsBrand: unique symbol;

/**
 * A signed integer count of cents. Positive = outflow.
 *
 * Branded so a raw `number` cannot be passed where money is expected. The brand
 * exists only at compile time; at runtime a Cents IS a number.
 */
export type Cents = number & { readonly [centsBrand]: true };

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Construction
// ─────────────────────────────────────────────────────────────────────────────

/** Largest magnitude we accept, in cents. ~$90 trillion — Number.MAX_SAFE_INTEGER. */
const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER;

/**
 * Currency symbols and whitespace, stripped before parsing digits.
 *
 * `\s` deliberately covers the non-breaking variants (U+00A0, U+202F) as well
 * as ordinary spaces — both turn up in bank data that has been copied through
 * a browser or a PDF, and a literal " " character class would silently miss
 * them.
 */
const CURRENCY_AND_SPACE = /[$\s]/g;

function assertSafe(value: number, context: string): void {
  if (!Number.isFinite(value)) {
    throw new MoneyError(`${context}: value is not finite (${value})`);
  }
  if (!Number.isInteger(value)) {
    throw new MoneyError(`${context}: value is not an integer number of cents (${value})`);
  }
  if (Math.abs(value) > MAX_SAFE_CENTS) {
    throw new MoneyError(`${context}: value exceeds safe integer range (${value})`);
  }
}

/**
 * Validate and brand a raw number as Cents.
 *
 * Also normalizes negative zero to positive zero. JavaScript produces `-0` from
 * ordinary arithmetic (`-1 * 0`, `-(0)`), and because `-0 === 0` is true it
 * hides from casual comparison — but `Object.is`, `Map`/`Set` keys, and some
 * serializers all distinguish it. A negative zero dollars is meaningless, so it
 * is eliminated here rather than left to surprise a comparison later.
 *
 * `value === 0` matches both `0` and `-0`, so returning the literal `0` in that
 * branch normalizes without a special case.
 */
function wrap(value: number, context: string): Cents {
  assertSafe(value, context);
  return (value === 0 ? 0 : value) as Cents;
}

/** Wrap an integer number of cents. Throws if it is not a safe integer. */
export function cents(value: number): Cents {
  return wrap(value, 'cents()');
}

export const ZERO: Cents = 0 as Cents;

/**
 * Parse a money string into Cents WITHOUT floating-point arithmetic.
 *
 * Accepts the shapes that actually appear in bank exports:
 *
 *     "12.34"        "-12.34"       "+12.34"
 *     "$1,234.56"    "-$1,234.56"   "$ 1,234.56"
 *     "(1,234.56)"   accounting-style negative
 *     "1234"         "1234."        ".50"
 *     ""             -> throws (callers decide whether blank means zero)
 *
 * Deliberately REJECTS more than two decimal places rather than rounding
 * silently. Rounding a bank figure without being asked is precisely the kind of
 * quiet corruption this project exists to avoid. If a real export turns out to
 * carry 3+ decimals, that is a deliberate decision to make with the data in
 * hand — not a default.
 *
 * NOTE: this returns the literal signed value in the string. It does NOT apply
 * Burmy's outflow-positive convention. Adapters do that, explicitly, so the
 * translation is visible and testable.
 */
export function parseMoney(input: string): Cents {
  if (typeof input !== 'string') {
    throw new MoneyError(`parseMoney: expected a string, got ${typeof input}`);
  }

  const original = input;
  let s = input.trim();

  if (s === '') {
    throw new MoneyError('parseMoney: empty string');
  }

  // Accounting-style negative: (1,234.56)
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1).trim();
  }

  // Currency symbol, before or after the sign.
  s = s.replace(CURRENCY_AND_SPACE, '').trim();

  // Explicit sign.
  if (s.startsWith('-')) {
    if (negative) {
      throw new MoneyError(`parseMoney: ambiguous double negative in "${original}"`);
    }
    negative = true;
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) {
    s = s.slice(1).trim();
  }

  // A currency symbol may have sat between the sign and the digits: "-$12.34".
  s = s.replace(CURRENCY_AND_SPACE, '').trim();

  // Thousands separators.
  s = s.replace(/,/g, '');

  if (s === '') {
    throw new MoneyError(`parseMoney: no digits in "${original}"`);
  }

  if (!/^\d*(\.\d*)?$/.test(s)) {
    throw new MoneyError(`parseMoney: unrecognized money format "${original}"`);
  }

  const [wholePart = '', fracPartRaw = ''] = s.split('.');

  if (wholePart === '' && fracPartRaw === '') {
    throw new MoneyError(`parseMoney: no digits in "${original}"`);
  }

  if (fracPartRaw.length > 2) {
    throw new MoneyError(
      `parseMoney: "${original}" has ${fracPartRaw.length} decimal places; ` +
        `refusing to round silently (expected at most 2)`,
    );
  }

  const whole = wholePart === '' ? 0 : Number(wholePart);
  const frac = fracPartRaw === '' ? 0 : Number(fracPartRaw.padEnd(2, '0'));

  if (!Number.isSafeInteger(whole)) {
    throw new MoneyError(`parseMoney: "${original}" is too large`);
  }

  const total = whole * 100 + frac;
  return wrap(negative ? -total : total, `parseMoney("${original}")`);
}

/**
 * Parse separate Debit and Credit columns into one signed Cents value.
 *
 * Some Bank of America exports use this shape instead of a single signed
 * column. Exactly one side must be populated — a row with both, or neither, is
 * malformed and fails loudly rather than guessing.
 *
 * Returns the value using Burmy's convention: DEBIT (money out) is POSITIVE.
 */
export function parseDebitCredit(debit: string | null, credit: string | null): Cents {
  const hasDebit = debit != null && debit.trim() !== '';
  const hasCredit = credit != null && credit.trim() !== '';

  if (hasDebit && hasCredit) {
    throw new MoneyError(
      `parseDebitCredit: both debit ("${debit}") and credit ("${credit}") are populated`,
    );
  }
  if (!hasDebit && !hasCredit) {
    throw new MoneyError('parseDebitCredit: neither debit nor credit is populated');
  }

  if (hasDebit) {
    return abs(parseMoney(debit as string));
  }
  return negate(abs(parseMoney(credit as string)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Arithmetic
// ─────────────────────────────────────────────────────────────────────────────

export function add(a: Cents, b: Cents): Cents {
  return wrap(a + b, 'add()');
}

export function subtract(a: Cents, b: Cents): Cents {
  return wrap(a - b, 'subtract()');
}

export function negate(a: Cents): Cents {
  return wrap(-a, 'negate()');
}

export function abs(a: Cents): Cents {
  return wrap(Math.abs(a), 'abs()');
}

export function sum(values: readonly Cents[]): Cents {
  let total = 0;
  for (const v of values) total += v;
  return wrap(total, 'sum()');
}

/**
 * Multiply by an integer count. Deliberately NOT a general float multiply —
 * scaling money by an arbitrary fraction requires an explicit rounding policy,
 * which `allocate` provides.
 */
export function multiply(a: Cents, factor: number): Cents {
  if (!Number.isInteger(factor)) {
    throw new MoneyError(`multiply: factor must be an integer, got ${factor}. Use allocate().`);
  }
  return wrap(a * factor, 'multiply()');
}

// ─────────────────────────────────────────────────────────────────────────────
// Comparison
// ─────────────────────────────────────────────────────────────────────────────

export const isZero = (a: Cents): boolean => a === 0;

/** Positive = money leaving the owner. */
export const isOutflow = (a: Cents): boolean => a > 0;

/** Negative = money arriving. Refunds and income are inflows. */
export const isInflow = (a: Cents): boolean => a < 0;

export const equals = (a: Cents, b: Cents): boolean => a === b;

/** Sort comparator: negative if a < b. */
export const compare = (a: Cents, b: Cents): number => (a < b ? -1 : a > b ? 1 : 0);

// ─────────────────────────────────────────────────────────────────────────────
// Allocation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split a total across weights so the parts sum EXACTLY to the total.
 *
 * Uses the largest-remainder method: floor every share, then hand the leftover
 * cents one at a time to the parts with the largest fractional remainders,
 * breaking ties by index so the result is deterministic.
 *
 * This is what guarantees the split-transaction invariant — children always sum
 * to the parent, with no drifting cent.
 *
 *     allocate(cents(10482), [5299, 1799, 2185, 1199])  // sums to 10482 exactly
 *
 * Weights must be non-negative and not all zero. Sign is taken from the total,
 * so allocating a negative (inflow) total works correctly.
 */
export function allocate(total: Cents, weights: readonly number[]): Cents[] {
  if (weights.length === 0) {
    throw new MoneyError('allocate: weights must not be empty');
  }
  for (const w of weights) {
    if (!Number.isFinite(w) || w < 0) {
      throw new MoneyError(`allocate: weights must be finite and non-negative, got ${w}`);
    }
  }

  const weightTotal = weights.reduce((acc, w) => acc + w, 0);
  if (weightTotal <= 0) {
    throw new MoneyError('allocate: weights must not sum to zero');
  }

  // Work in absolute value, reapply the sign at the end, so that negative
  // totals distribute identically rather than skewing toward zero.
  const sign = total < 0 ? -1 : 1;
  const magnitude = Math.abs(total);

  const exact = weights.map((w) => (magnitude * w) / weightTotal);
  const floors = exact.map((v) => Math.floor(v));
  const distributed = floors.reduce((acc, v) => acc + v, 0);
  let remainder = magnitude - distributed;

  // Largest fractional remainder first; ties broken by index for determinism.
  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => (b.frac - a.frac) || (a.index - b.index));

  const result = [...floors];
  for (let i = 0; i < order.length && remainder > 0; i++) {
    result[order[i]!.index]! += 1;
    remainder -= 1;
  }

  return result.map((v) => cents(v * sign));
}

/** Split a total into `parts` equal shares, distributing the remainder deterministically. */
export function allocateEvenly(total: Cents, parts: number): Cents[] {
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new MoneyError(`allocateEvenly: parts must be a positive integer, got ${parts}`);
  }
  return allocate(total, new Array<number>(parts).fill(1));
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting — the UI edge, and ONLY the UI edge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format for display, e.g. `$1,234.56`.
 *
 * By default the sign is dropped, because Burmy's grid shows spending as a
 * plain positive figure — an outflow of 6000 reads "$60.00", not "+$60.00".
 * Pass `signed: true` where the direction matters (drill-down rows, refunds).
 */
export function format(
  value: Cents,
  options: { signed?: boolean; currency?: string; locale?: string } = {},
): string {
  const { signed = false, currency = 'USD', locale = 'en-US' } = options;

  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const magnitude = Math.abs(value) / 100;
  const body = formatter.format(magnitude);

  if (!signed) return body;
  if (value < 0) return `-${body}`;
  return body;
}

/**
 * Format for the Income section, which displays inflows as positive.
 *
 * Income is STORED negative (money arriving, per the outflow-positive rule) but
 * a paycheck must read "$6,400.00", not "-$6,400.00". This flip is display-only
 * and never touches a stored value.
 */
export function formatInflow(value: Cents, options: Parameters<typeof format>[1] = {}): string {
  return format(negate(value), { ...options, signed: true });
}

/** Plain decimal string for exports and tests, e.g. `-1234.56`. No symbol, no separators. */
export function toDecimalString(value: Cents): string {
  const sign = value < 0 ? '-' : '';
  const magnitude = Math.abs(value);
  const whole = Math.floor(magnitude / 100);
  const frac = magnitude % 100;
  return `${sign}${whole}.${String(frac).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Database boundary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a value read from a BIGINT column into Cents.
 *
 * Drizzle may hand back a `string` or a `bigint` for BIGINT columns depending on
 * driver configuration, so this normalizes all three shapes in one place rather
 * than scattering coercions across query modules.
 */
export function fromDb(value: number | string | bigint | null | undefined): Cents {
  if (value == null) {
    throw new MoneyError('fromDb: received null/undefined where a money value was expected');
  }
  if (typeof value === 'bigint') {
    if (value > BigInt(MAX_SAFE_CENTS) || value < BigInt(-MAX_SAFE_CENTS)) {
      throw new MoneyError(`fromDb: bigint ${value} exceeds safe integer range`);
    }
    return cents(Number(value));
  }
  if (typeof value === 'string') {
    if (!/^-?\d+$/.test(value.trim())) {
      throw new MoneyError(`fromDb: expected an integer string of cents, got "${value}"`);
    }
    return cents(Number(value.trim()));
  }
  return cents(value);
}

/** Convert Cents to the value written to a BIGINT column. */
export function toDb(value: Cents): number {
  assertSafe(value, 'toDb()');
  return value;
}
