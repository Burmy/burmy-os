/**
 * Accounts and categories — the pure rules.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO DATABASE, NO HTTP, NO REACT. This is `src/server/finance/`.
 *
 * Everything here takes plain data and returns plain data, so name handling,
 * reordering and the `last_four` guard are all testable in milliseconds. The
 * owner-scoped I/O that uses these lives in `src/server/db/finance/`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Longest name that fits a grid row label without wrapping awkwardly. */
export const MAX_NAME_LENGTH = 60;

export class InvalidNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidNameError';
  }
}

export class InvalidLastFourError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLastFourError';
  }
}

/**
 * Collapse whitespace and trim, preserving the owner's capitalisation.
 *
 * Case is preserved because these are display labels — the row axis of the grid.
 * `Planet Fitness` is a legitimate category name and must not become
 * `planet fitness`. Uniqueness is enforced case-INSENSITIVELY in the database,
 * so preserving case here cannot create a duplicate.
 */
export function normalizeName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * @throws InvalidNameError
 */
export function assertValidName(raw: string): string {
  const name = normalizeName(raw);

  if (name.length === 0) throw new InvalidNameError('Name is required');
  if (name.length > MAX_NAME_LENGTH) {
    throw new InvalidNameError(`Name must be ${MAX_NAME_LENGTH} characters or fewer`);
  }

  return name;
}

/**
 * A stable, URL-safe key for a category name.
 *
 * This is for routing and stable references only — it is NOT an identity key and
 * NOT a merchant key. `dedupe_key` and `merchant_key` are separate concepts and
 * neither is derived from this (see docs/FINANCE.md).
 */
export function slugifyName(raw: string): string {
  const slug = normalizeName(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // A name of nothing but punctuation ("!!!") would otherwise slug to ''. A
  // blank slug is worse than an ugly one, so fall back to a marker rather than
  // writing an empty string into a NOT NULL column.
  return slug || 'category';
}

/**
 * Parse the optional last-four-digits fragment.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A LONGER NUMBER IS REJECTED, NEVER TRUNCATED.
 *
 * Truncating would be the "helpful" behaviour and it is the wrong one. If the
 * owner pastes a full 16-digit card number, silently keeping the last four means
 * the full number was accepted by the application — it sits in the request body,
 * in any error report that captured it, and possibly in a log line — and nothing
 * ever told anyone. Rejecting makes the mistake visible at the only moment it can
 * still be undone.
 *
 * `last_four` is the ONLY account-number fragment Burmy ever stores.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * @throws InvalidLastFourError
 */
export function parseLastFour(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;

  const value = raw.trim();
  if (value === '') return null;

  if (!/^\d{4}$/.test(value)) {
    throw new InvalidLastFourError('Enter exactly 4 digits, or leave blank');
  }

  return value;
}

/**
 * Move one id up or down by a single position.
 *
 * Pure, so the reorder rules are unit-testable without a database or a pointer:
 * moving the first item up, or the last item down, is a NO-OP rather than an
 * error — the buttons are simply disabled at the ends, and a double-click racing
 * the disable must not throw.
 *
 * Drag-and-drop was deliberately not used. Up/down buttons are keyboard
 * accessible by construction, need no dependency, and this list is reordered a
 * handful of times a year.
 */
export function moveInOrder<T>(items: readonly T[], index: number, delta: -1 | 1): T[] {
  const next = [...items];
  const target = index + delta;

  if (index < 0 || index >= next.length) return next;
  if (target < 0 || target >= next.length) return next;

  const moved = next[index] as T;
  next[index] = next[target] as T;
  next[target] = moved;

  return next;
}

/**
 * Renumber `sort_order` densely from 0.
 *
 * Sparse or duplicated orders make the grid's row sequence depend on whatever
 * secondary ordering the database happens to apply, which is how a row silently
 * moves between page loads. Rewriting the whole sequence is cheap at this size
 * and removes the question.
 */
export function denseOrder(ids: readonly string[]): Array<{ id: string; sortOrder: number }> {
  return ids.map((id, index) => ({ id, sortOrder: index }));
}
