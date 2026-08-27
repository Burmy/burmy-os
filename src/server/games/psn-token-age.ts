/**
 * PSN NPSSO token age — pure, framework-free (no React, no Next, no HTTP).
 *
 * Sony documents no exact NPSSO lifetime anywhere; observed behavior puts it
 * at roughly 60 days (the same figure `psn-actions.ts`'s
 * `PSN_TOKEN_EXPIRED_MESSAGE` already quotes to the owner). Because that
 * number is an approximation, not a contract, this module never computes or
 * prints a confident countdown to a specific day or hour — it only
 * classifies an elapsed whole-day count into a coarse status the UI can
 * react to.
 */

export type PsnTokenAgeStatus = 'unknown' | 'normal' | 'warning';

export interface PsnTokenAge {
  /** `'unknown'` exactly when `ageDays` is `null` — the current token has never completed a successful sync. */
  readonly status: PsnTokenAgeStatus;
  readonly ageDays: number | null;
}

/** Sony's roughly-observed, nowhere-documented NPSSO lifetime. Approximate — never treated as an exact deadline. */
export const PSN_TOKEN_APPROX_LIFETIME_DAYS = 60;

/**
 * Past this many days in use, the token is old enough that expiry could be
 * near (a comfortable margin below the ~60-day approximate lifetime) — the
 * UI switches from quiet chrome to a visible warning.
 */
export const PSN_TOKEN_WARNING_THRESHOLD_DAYS = 45;

/**
 * Classifies the current PSN token's age from `inUseSince` — the earliest
 * successful run stored under the CURRENT token's fingerprint (see
 * `getPsnTokenInUseSince` in `src/server/db/games/sync.ts`), or `null` when
 * that specific token has never synced successfully. `now` defaults to
 * `new Date()` but is accepted as a parameter so tests can pin it instead
 * of depending on the wall clock.
 *
 * A negative elapsed time (a clock skew, or `inUseSince` somehow in the
 * future) clamps to zero rather than reporting a negative age.
 */
export function psnTokenAge(inUseSince: Date | null, now: Date = new Date()): PsnTokenAge {
  if (inUseSince === null) return { status: 'unknown', ageDays: null };

  const elapsedMs = now.getTime() - inUseSince.getTime();
  const ageDays = Math.max(0, Math.floor(elapsedMs / (24 * 60 * 60 * 1000)));

  return {
    status: ageDays >= PSN_TOKEN_WARNING_THRESHOLD_DAYS ? 'warning' : 'normal',
    ageDays,
  };
}
