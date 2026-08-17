/**
 * Errors the finance data-access layer raises.
 *
 * These exist so a Server Action can turn a database constraint into a FIELD
 * error instead of a 500. A duplicate category name is ordinary user input, not
 * an exception.
 */

/** Postgres `unique_violation`. */
const PG_UNIQUE_VIOLATION = '23505';

export class DuplicateNameError extends Error {
  // `duplicateName`, not `name` — `Error.name` is the error TYPE, and shadowing
  // it with the offending value both breaks the type and makes every log line
  // report the category name where the error class should be.
  constructor(readonly duplicateName: string) {
    super(`"${duplicateName}" already exists`);
    this.name = 'DuplicateNameError';
  }
}

/**
 * The row does not exist, or belongs to someone else.
 *
 * Deliberately ONE error for both. Distinguishing them would let a caller probe
 * for the existence of another owner's rows — and with a single-owner
 * application, "not yours" is only reachable by a crafted id in the first place.
 */
export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

/** The import is not in `review` status — already committed, discarded, or mid-commit. */
export class ImportNotReviewableError extends Error {
  constructor(readonly status: string) {
    super(`This import is ${status.replace(/_/g, ' ')}, not awaiting review.`);
    this.name = 'ImportNotReviewableError';
  }
}

/**
 * Is this a Postgres unique-constraint violation?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WALKS THE `cause` CHAIN, and must.
 *
 * Drizzle does not surface driver errors directly — it wraps them in its own
 * error carrying `query` and `params`, and puts the original underneath as
 * `cause`. So `error.code` is `undefined` on the thing that is actually thrown,
 * and a naive check silently never matches: the duplicate-name path would compile,
 * look correct, and turn every duplicate into an unhandled 500 instead of a field
 * error. That is exactly what happened here, and it was caught by the integration
 * tests rather than by review.
 *
 * Matching the SQLSTATE rather than message text keeps this working across
 * locales and Postgres versions.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function isUniqueViolation(error: unknown): boolean {
  // Bounded so a self-referential cause cannot loop forever.
  let current: unknown = error;

  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;

    if ((current as { code?: unknown }).code === PG_UNIQUE_VIOLATION) return true;

    current = (current as { cause?: unknown }).cause;
  }

  return false;
}
