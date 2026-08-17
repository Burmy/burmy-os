/**
 * `requireOwner()` — THE security boundary.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY EVERY ENTRY POINT CALLS THIS ITSELF
 *
 * Next.js handles Server Functions as POSTs to the route where they are USED.
 * So moving an action into a different component, or editing the proxy
 * `matcher`, can remove proxy coverage from a mutation with no error, no type
 * failure, and no failing test. The proxy is a second layer; it is not the
 * boundary. Anything server-invocable begins with `await requireOwner()`.
 *
 * WHY IT CHECKS BOTH FACTORS AND NOT JUST THE SESSION
 *
 * If this only validated the Better Auth session, then a route the matcher
 * missed would be defended by factor 2 alone — the proxy's silent-gap hazard
 * would still cost us something, just less. Verifying the Access assertion here
 * too means each entry point independently enforces BOTH factors, and the gap
 * costs nothing. Verification is a signature check against cached public keys,
 * so the price is negligible.
 *
 * THE UNPROTECTED ALLOWLIST IS EXACTLY TWO ENTRIES
 *
 *   /api/health    booleans and a version string only
 *   /api/auth/*    Better Auth's own flows, which authenticate by design
 *
 * Anything else that does not call this function is a bug, and
 * tests/integration/entry-points.test.ts enumerates the filesystem to prove it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { count, eq } from 'drizzle-orm';
import { headers as nextHeaders } from 'next/headers';

import { getDb } from '@/server/db';
import { passkey as passkeyTable } from '@/server/db/schema';
import { AUDIT_EVENT, fingerprintEmail, recordAuditEvent } from '@/server/security/audit';
import {
  AccessDeniedError,
  AccessMisconfiguredError,
  isOwnerEmail,
  requireAccessIdentity,
} from './access';
import { auth } from './index';

/**
 * Two passkeys minimum before onboarding is complete.
 *
 * One passkey is a single point of failure whose recovery path deliberately
 * requires SSH, Tailscale membership and a terminal. Enrolling a second one
 * takes twenty seconds at a moment when the owner is already authenticated, and
 * it is the difference between "lost a phone" and "invoke break-glass".
 */
export const MIN_PASSKEYS = 2;

export interface OwnerContext {
  readonly userId: string;
  readonly email: string;
  readonly sessionId: string;
  readonly sessionCreatedAt: Date;
  readonly passkeyCount: number;
  readonly onboardingComplete: boolean;
}

export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/** Authenticated, but fewer than `MIN_PASSKEYS` enrolled. */
export class OnboardingIncompleteError extends Error {
  constructor(readonly passkeyCount: number) {
    super('Passkey onboarding incomplete');
    this.name = 'OnboardingIncompleteError';
  }
}

/** Authenticated, but the session is too old for a sensitive action. */
export class ReauthRequiredError extends Error {
  constructor() {
    super('Re-authentication required');
    this.name = 'ReauthRequiredError';
  }
}

/** The deployment cannot verify factor 1. Refuse, never fall through. */
export class SecurityUnavailableError extends Error {
  constructor() {
    super('Security configuration unavailable');
    this.name = 'SecurityUnavailableError';
  }
}

export interface RequireOwnerOptions {
  /**
   * Require a session created within `session.freshAge` (15 minutes).
   * For sensitive actions: passkey removal, bulk deletion, full export,
   * changing `OWNER_EMAIL`.
   */
  readonly fresh?: boolean;
  /**
   * Permit a session that has not finished passkey onboarding. ONLY the
   * onboarding route and its own actions may set this.
   */
  readonly allowOnboarding?: boolean;
}

/** 15 minutes, matching `session.freshAge` in the Better Auth options. */
const FRESH_AGE_MS = 60 * 15 * 1000;

async function countPasskeys(userId: string): Promise<number> {
  const rows = await getDb()
    .select({ value: count() })
    .from(passkeyTable)
    .where(eq(passkeyTable.userId, userId));
  return rows[0]?.value ?? 0;
}

/**
 * Authenticate and authorize the owner.
 *
 * @throws SecurityUnavailableError · UnauthorizedError · OnboardingIncompleteError · ReauthRequiredError
 */
export async function requireOwner(options: RequireOwnerOptions = {}): Promise<OwnerContext> {
  const requestHeaders = await nextHeaders();

  // ── Factor 1: Cloudflare Access ───────────────────────────────────────────
  try {
    await requireAccessIdentity(requestHeaders);
  } catch (cause) {
    if (cause instanceof AccessMisconfiguredError) {
      await recordAuditEvent({
        eventType: AUDIT_EVENT.ACCESS_MISCONFIGURED,
        subjectType: 'entry_point',
      });
      throw new SecurityUnavailableError();
    }
    if (cause instanceof AccessDeniedError) {
      await recordAuditEvent({
        eventType: AUDIT_EVENT.ENTRY_POINT_UNAUTHENTICATED,
        subjectType: 'access',
        metadata: { reason: 'access_denied' },
      });
      throw new UnauthorizedError();
    }
    throw cause;
  }

  // ── Factor 2: Better Auth passkey session ─────────────────────────────────
  const result = await auth.api.getSession({ headers: requestHeaders });

  if (!result?.session || !result.user) {
    await recordAuditEvent({
      eventType: AUDIT_EVENT.ENTRY_POINT_UNAUTHENTICATED,
      subjectType: 'session',
      metadata: { reason: 'no_session' },
    });
    throw new UnauthorizedError();
  }

  // Checked again at every request, not only at session creation. A session row
  // that somehow belongs to another address stops working immediately, which is
  // what makes changing `OWNER_EMAIL` a safe operation.
  if (!isOwnerEmail(result.user.email)) {
    await recordAuditEvent({
      eventType: AUDIT_EVENT.ACCESS_NON_OWNER,
      subjectType: 'session',
      subjectId: result.session.id,
      metadata: { emailFingerprint: fingerprintEmail(result.user.email) },
    });
    throw new UnauthorizedError();
  }

  const sessionCreatedAt = new Date(result.session.createdAt);

  if (options.fresh === true && Date.now() - sessionCreatedAt.getTime() >= FRESH_AGE_MS) {
    await recordAuditEvent({
      eventType: AUDIT_EVENT.REAUTH_FAILURE,
      ownerId: result.user.id,
      subjectType: 'session',
      subjectId: result.session.id,
    });
    throw new ReauthRequiredError();
  }

  const passkeyCount = await countPasskeys(result.user.id);
  const onboardingComplete = passkeyCount >= MIN_PASSKEYS;

  if (!onboardingComplete && options.allowOnboarding !== true) {
    throw new OnboardingIncompleteError(passkeyCount);
  }

  return {
    userId: result.user.id,
    email: result.user.email,
    sessionId: result.session.id,
    sessionCreatedAt,
    passkeyCount,
    onboardingComplete,
  };
}

/**
 * Map a guard failure onto an HTTP response for Route Handlers.
 *
 * Bodies carry no detail. "Which check failed" is useful to an attacker probing
 * the boundary and useless to the one legitimate user, who has the audit table.
 * Returns null for anything that is not a guard error, so genuine bugs keep
 * propagating instead of being flattened into a 401.
 */
export function toAuthErrorResponse(error: unknown): Response | null {
  if (error instanceof SecurityUnavailableError) {
    return new Response(null, { status: 503 });
  }
  if (error instanceof UnauthorizedError) {
    return new Response(null, { status: 401 });
  }
  if (error instanceof ReauthRequiredError) {
    return new Response(null, { status: 403 });
  }
  if (error instanceof OnboardingIncompleteError) {
    return new Response(null, { status: 403 });
  }
  return null;
}
