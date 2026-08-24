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
 * A sync run does not exist, or belongs to someone else. One error for both —
 * same "don't let a crafted id distinguish the two" reasoning as
 * `GameNotFoundError`.
 */
export class SyncRunNotFoundError extends Error {
  constructor() {
    super('Sync run not found');
    this.name = 'SyncRunNotFoundError';
  }
}

/** Committing an already-`committed` run would double-apply every selected change. */
export class SyncRunAlreadyCommittedError extends Error {
  constructor() {
    super('This sync run has already been committed');
    this.name = 'SyncRunAlreadyCommittedError';
  }
}

/**
 * Only a `ready` run may be committed. `running` has chunks still in flight
 * — approving it commits a half-populated set, and the engine would go on
 * appending changes to a run that is now `committed`. `failed`/`cancelled`
 * have nothing valid to apply. `committed` gets its OWN dedicated error
 * (`SyncRunAlreadyCommittedError` above) rather than this one, so "already
 * committed" stays the exact message a double-commit sees.
 */
export class SyncRunNotReadyError extends Error {
  constructor(readonly status: string) {
    super(`This sync run is ${status}, not ready to commit.`);
    this.name = 'SyncRunNotReadyError';
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
