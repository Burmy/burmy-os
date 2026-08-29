/**
 * Anime's own error classes.
 *
 * Duplicated from `src/server/db/games/errors.ts` rather than shared, on
 * purpose and for the reason that file's own header gives about Finance: a
 * shared error module would couple two domains that are otherwise independent,
 * to save a handful of one-line classes.
 */

/** A row that does not exist, OR belongs to someone else. One error for both, so a crafted id cannot be used to probe for another owner's rows. */
export class AnimeNotFoundError extends Error {
  constructor() {
    super('That anime is no longer in your library.');
    this.name = 'AnimeNotFoundError';
  }
}

export class AnimeSeriesNotFoundError extends Error {
  constructor() {
    super('That series is no longer in your library.');
    this.name = 'AnimeSeriesNotFoundError';
  }
}

/** Same probe-prevention reasoning as `AnimeNotFoundError`. */
export class AnimeSyncRunNotFoundError extends Error {
  constructor() {
    super('That sync run no longer exists.');
    this.name = 'AnimeSyncRunNotFoundError';
  }
}

/** Its own class rather than a message on a generic error, so a double-click keeps its exact wording. */
export class AnimeSyncRunAlreadyCommittedError extends Error {
  constructor() {
    super('That sync has already been applied.');
    this.name = 'AnimeSyncRunAlreadyCommittedError';
  }
}

export class AnimeSyncRunNotReadyError extends Error {
  readonly status: string;

  constructor(status: string) {
    super('That sync is not finished yet.');
    this.name = 'AnimeSyncRunNotReadyError';
    this.status = status;
  }
}

const PG_UNIQUE_VIOLATION = '23505';
const MAX_CAUSE_DEPTH = 5;

/**
 * Whether an error is a Postgres unique violation.
 *
 * WALKS THE `cause` CHAIN, and that is the whole point. Drizzle WRAPS driver
 * errors: a `23505` arrives as a Drizzle error carrying `query`/`params`, with
 * the real SQLSTATE on `error.cause`. A naive `error.code === '23505'`
 * compiles, reads correctly, and silently never matches — turning every
 * duplicate into an unhandled 500. See CLAUDE.md; this cost the Games module a
 * real bug, caught by integration tests rather than review.
 *
 * Copied rather than imported from `db/games/errors.ts` for the same reason
 * that file copied it from Finance's.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== null && current !== undefined; depth += 1) {
    if (typeof current === 'object' && (current as { code?: unknown }).code === PG_UNIQUE_VIOLATION) {
      return true;
    }
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
  }

  return false;
}
