/**
 * Errors the games data-access layer raises.
 *
 * Deliberately NOT imported from `src/server/db/finance/errors.ts`: Games and
 * Finance share no code by design, and these errors carry games-specific
 * payloads. The duplicated `isUniqueViolation` below is the one piece of real
 * repetition, and it is repeated on purpose rather than creating a shared
 * module that couples the two.
 */

/** Postgres `unique_violation`. */
const PG_UNIQUE_VIOLATION = '23505';

export class DuplicateGameError extends Error {
  // `duplicateTitle`, not `title` — `Error.name` is the error TYPE and must not
  // be shadowed by the offending value.
  constructor(readonly duplicateTitle: string) {
    super(`"${duplicateTitle}" is already in your library on that platform`);
    this.name = 'DuplicateGameError';
  }
}

/**
 * The row does not exist, or belongs to someone else. One error for both, so a
 * crafted id cannot be used to probe for another owner's rows.
 */
export class GameNotFoundError extends Error {
  constructor() {
    super('Game not found');
    this.name = 'GameNotFoundError';
  }
}

/**
 * Drizzle WRAPS driver errors — the SQLSTATE lives on the `cause` chain, not on
 * `error.code`. A naive `error.code === '23505'` compiles, reads correctly, and
 * silently never matches, turning every duplicate title into an unhandled 500.
 * Bounded loop so a self-referential cause cannot spin forever.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;

  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if ((current as { code?: unknown }).code === PG_UNIQUE_VIOLATION) return true;
    current = (current as { cause?: unknown }).cause;
  }

  return false;
}
