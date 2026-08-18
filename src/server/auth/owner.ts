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
 * WHAT THIS DOES, IN FULL
 *
 * Cloudflare Access — verified against Cloudflare's JWKS, fail-closed — is the
 * SOLE interactive authentication mechanism (see docs/SECURITY.md). This
 * function verifies that assertion via `requireAccessIdentity()`, which
 * already confirms the verified email is the configured `OWNER_EMAIL`, then
 * RESOLVES (never creates) the matching row in `user`. There is no session,
 * no passkey, no second factor: the Access JWT is re-verified on every single
 * request, so there is nothing here to revoke or expire independently — an
 * owner who is removed from the Cloudflare Access policy loses access on
 * their very next request.
 *
 * "Resolve, never create" is deliberate: the owner row is provisioned once,
 * out of band, by `scripts/provision-owner.mjs` — a request authenticating as
 * the owner's Google account must never be able to conjure a database row
 * into existence on its own. If the row is missing, that is a provisioning
 * gap, not something this function fixes silently.
 *
 * THE UNPROTECTED ALLOWLIST IS EXACTLY ONE ENTRY
 *
 *   /api/health    booleans and a version string only
 *
 * Anything else that does not call this function is a bug, and
 * tests/integration/entry-points.test.ts enumerates the filesystem to prove it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { eq } from 'drizzle-orm';
import { headers as nextHeaders } from 'next/headers';

import { getDb } from '@/server/db';
import { user as userTable } from '@/server/db/schema';
import { AUDIT_EVENT, recordAuditEvent } from '@/server/security/audit';
import { AccessDeniedError, AccessMisconfiguredError, requireAccessIdentity } from './access';

export interface OwnerContext {
  readonly userId: string;
  readonly email: string;
}

export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/** The deployment cannot verify Cloudflare Access. Refuse, never fall through. */
export class SecurityUnavailableError extends Error {
  constructor() {
    super('Security configuration unavailable');
    this.name = 'SecurityUnavailableError';
  }
}

/**
 * Authenticate the owner via Cloudflare Access and resolve their row.
 *
 * @throws SecurityUnavailableError · UnauthorizedError
 */
export async function requireOwner(): Promise<OwnerContext> {
  const requestHeaders = await nextHeaders();

  // ── Cloudflare Access: verify the JWT, confirm it is the owner ────────────
  let email: string;
  try {
    ({ email } = await requireAccessIdentity(requestHeaders));
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

  // ── Resolve the owner row — RESOLVE ONLY, never insert one ────────────────
  // By this point `email` is guaranteed to equal the configured `OWNER_EMAIL`
  // (requireAccessIdentity() already checked it). A missing row here means the
  // owner has never been provisioned — see scripts/provision-owner.mjs — not
  // that the visitor is untrusted.
  const rows = await getDb()
    .select({ id: userTable.id, email: userTable.email })
    .from(userTable)
    .where(eq(userTable.email, email))
    .limit(1);

  const row = rows[0];
  if (!row) {
    await recordAuditEvent({
      eventType: AUDIT_EVENT.ENTRY_POINT_UNAUTHENTICATED,
      subjectType: 'access',
      metadata: { reason: 'owner_not_provisioned' },
    });
    throw new UnauthorizedError();
  }

  return { userId: row.id, email: row.email };
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
  return null;
}
