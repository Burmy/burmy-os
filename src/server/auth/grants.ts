/**
 * Out-of-band grants — the tokens behind bootstrap and break-glass recovery.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM THESE SOLVE
 *
 * A passkey is the only way in, which raises two questions the passkey plugin
 * itself does not answer:
 *
 *   BOOTSTRAP — how does the FIRST passkey get registered when there is no
 *               session and no password to authorize registering it?
 *   RECOVERY  — what happens when every enrolled passkey is gone?
 *
 * Both need the same primitive: proof, established outside the browser, that the
 * person asking is the operator of the machine. That proof is a grant token,
 * minted by `scripts/auth-grant.mjs` over SSH-through-Tailscale and printed once
 * to a terminal. It is never emailed, never sent over HTTP, and never rendered
 * by the application. An email path would be a permanent phishable backdoor
 * around the very factor the passkey exists to provide.
 *
 * WHY THE TOKEN IS STORED HASHED
 *
 * The row lives in Postgres, and Postgres is dumped nightly to an off-site
 * backup. Storing the token verbatim would mean every backup contains a working
 * login credential for its whole TTL, and `restore into a scratch database` is a
 * routine, rehearsed operation. Storing `sha256(token)` means the database knows
 * only how to RECOGNIZE the token, never how to produce one. The usable secret
 * exists solely in the operator's terminal scrollback for ten minutes.
 *
 * WHY `verification` AND NOT A NEW TABLE
 *
 * Better Auth's `consumeVerificationValue()` reads and deletes inside one
 * database transaction via an atomic `consumeOne`, then rejects anything already
 * past `expiresAt`. That is precisely "single-use and short-lived", implemented
 * and tested upstream. Reimplementing it would mean hand-rolling the atomicity
 * that makes single-use actually single-use — and CLAUDE.md forbids custom
 * cryptography for the same class of reason.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** What a grant authorizes. Bootstrap and recovery are NOT interchangeable. */
export type GrantKind = 'bootstrap' | 'recovery';

/**
 * Ten minutes.
 *
 * Long enough to paste a token from an SSH session into a browser on another
 * device; short enough that a token left in scrollback is inert by the time
 * anyone walks away from the terminal. The TTL is enforced by Better Auth on
 * consume, so an expired row cannot be redeemed even if it is still present.
 */
export const GRANT_TTL_SECONDS = 600;

/** Namespaced so a grant can never collide with a WebAuthn challenge. */
const GRANT_PREFIX = 'burmy-grant';

export interface GrantPayload {
  readonly kind: GrantKind;
  /** The owner email the grant was minted for, re-checked on redemption. */
  readonly email: string;
  readonly issuedAt: string;
}

/**
 * 256 bits, base64url.
 *
 * Unguessable is the entire security property here — there is no second factor
 * on a grant, which is why it is short-lived, single-use, rate-limited and
 * audited.
 */
export function generateGrantToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The `verification.identifier` a token is stored under. */
export function grantIdentifier(token: string): string {
  const digest = createHash('sha256').update(token, 'utf8').digest('hex');
  return `${GRANT_PREFIX}:${digest}`;
}

export function encodeGrantPayload(payload: GrantPayload): string {
  return JSON.stringify(payload);
}

/**
 * Parse a stored payload, returning null on anything unexpected.
 *
 * Defensive because this string comes back out of the database: a truncated or
 * hand-edited row must fail closed rather than throw somewhere further up.
 */
export function decodeGrantPayload(raw: string): GrantPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;

  const { kind, email, issuedAt } = candidate;
  if (kind !== 'bootstrap' && kind !== 'recovery') return null;
  if (typeof email !== 'string' || !email) return null;
  if (typeof issuedAt !== 'string' || !issuedAt) return null;

  return { kind, email, issuedAt };
}

/**
 * Constant-time comparison of two grant kinds.
 *
 * Honestly: this is not defending against a timing attack — the kind is not a
 * secret and there are two possible values. It exists so that the comparison of
 * the *expected* kind against the *stored* kind reads as a deliberate check
 * rather than something a refactor can fold away, because a bootstrap grant
 * satisfying a recovery redemption (or the reverse) would silently merge two
 * paths whose whole point is that they are separate.
 */
export function grantKindMatches(expected: GrantKind, actual: GrantKind): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function grantExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + GRANT_TTL_SECONDS * 1000);
}
