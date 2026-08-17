import { createHash } from 'node:crypto';

/**
 * Adapter selection by HEADER SIGNATURE, never by filename.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY NOT THE FILENAME
 *
 * A renamed file must still be recognized, and an unrecognized file must never
 * be silently mis-parsed. Both failure modes are real: the real card export used
 * during M4 was named for May but covered 04/28–05/27, so even the period in the
 * name was wrong.
 *
 * WHY A HASH OF THE SET, NOT THE STRING
 *
 * Column ORDER has already changed once between BoA products and will change
 * again. Hashing a sorted set of normalized names means a reordered export keeps
 * its identity, while an added or removed column correctly produces a new
 * signature that has to be mapped once and remembered
 * (`finance_format_signatures`).
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Normalize one header cell to a lookup key.
 *
 * `Running Bal.` → `running_bal`, `Posted Date` → `posted_date`. Punctuation and
 * case are dropped because they are exactly what a bank changes between exports
 * without changing meaning.
 */
export function normalizeHeaderName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * A stable identity for a set of headers.
 *
 * Empty names are dropped rather than positioned: the BoA deposit preamble has a
 * genuinely empty middle column (`Description,,Summary Amt.`), and treating that
 * absence as a named column would make the signature depend on where the gap fell.
 */
export function headerSignature(headers: readonly string[]): string {
  const names = headers.map(normalizeHeaderName).filter((name) => name !== '');
  const canonical = [...new Set(names)].sort().join('|');
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}

/** Does this header row contain every column the adapter needs? */
export function hasAllColumns(
  headers: readonly string[],
  required: readonly string[],
): boolean {
  const present = new Set(headers.map(normalizeHeaderName));
  return required.every((name) => present.has(name));
}

/**
 * The columns each known adapter requires.
 *
 * Matching on REQUIRED columns rather than on an exact signature means a BoA
 * export that gains a column still parses, instead of falling through to the
 * generic mapper and asking the owner to re-map a format they already mapped.
 * The exact signature is still recorded, so a genuinely new layout is
 * recognizable.
 */
export const ADAPTER_COLUMNS = {
  'boa-deposit': ['date', 'description', 'amount'],
  'boa-card': ['posted_date', 'payee', 'amount'],
} as const;

/**
 * Column names that mark the SUMMARY header in a BoA deposit export, which sits
 * above the real one and must not be mistaken for it.
 *
 * `Description,,Summary Amt.` normalizes to `description` + `summary_amt`. Note
 * it shares `description` with the real header — which is exactly why the real
 * header is identified by having ALL of `date`/`description`/`amount`, and this
 * one is skipped for lacking `date`.
 */
export const DEPOSIT_SUMMARY_COLUMNS = ['description', 'summary_amt'] as const;
