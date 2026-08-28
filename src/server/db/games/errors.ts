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
 * A duplicate `igdb_id` on a wishlist add — the owner already has a `games`
 * row for this exact IGDB game, wishlisted or since promoted to `backlog`.
 * Deliberately its own class rather than reusing `DuplicateGameError`: that
 * one's message ("the same game on a different platform is fine") describes
 * the title+platform index, not this one, and repeating it here would be
 * actively misleading about what actually collided.
 */
export class DuplicateWishlistGameError extends Error {
  constructor(readonly duplicateTitle: string) {
    super(`"${duplicateTitle}" is already in your library.`);
    this.name = 'DuplicateWishlistGameError';
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
 * A proposed `collection_id` would break the one-level rule.
 *
 * Collections are exactly one level deep — a collection holds games, and a
 * game inside one can never itself hold others. Three ways to violate that,
 * all refused here rather than by a CHECK constraint (which would need a
 * subquery): pointing a game at ITSELF, pointing it at a row that is already
 * inside another collection, and turning a row that already HAS games into
 * somebody else's member — which would orphan its own contents a level down
 * where nothing renders them.
 *
 * `reason` is carried so the Server Action can say which of the three
 * happened; the owner sees a sentence, not a constraint name.
 */
export class InvalidCollectionError extends Error {
  constructor(readonly reason: 'self' | 'target-is-member' | 'already-a-collection') {
    super(
      reason === 'self'
        ? 'A game cannot be inside itself.'
        : reason === 'target-is-member'
          ? 'That game is already inside another collection — collections are only one level deep.'
          : 'This game already holds other games, so it cannot also sit inside one.',
    );
    this.name = 'InvalidCollectionError';
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
