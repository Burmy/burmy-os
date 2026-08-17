/**
 * Security audit trail.
 *
 * Writes to `audit_events`. What is recorded is a deliberately short list — the
 * security-relevant events from docs/SECURITY.md — and what is recorded ABOUT
 * them is deliberately thin.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REDACTION IS THE DEFAULT, NOT A FEATURE
 *
 * An audit table is the one place where "log a bit more, just in case" quietly
 * accumulates the exact data the rest of the application is careful with. So:
 *
 *   - No raw statement rows, descriptions, or amounts. Ever.
 *   - No tokens, no cookies, no session tokens, no Access assertions.
 *   - A REJECTED third party's email address is stored as a short hash, not as
 *     an address. Correlating repeated attempts does not require retaining
 *     somebody's identity — and a non-owner email is someone else's PII sitting
 *     in a personal finance database.
 *   - The owner's own email is not stored either. There is exactly one owner and
 *     `OWNER_EMAIL` already names them; a copy per row buys nothing.
 *
 * An audit write must never break authentication: a failure here is logged and
 * swallowed. Denying the owner access because a bookkeeping insert failed would
 * turn a logging outage into a lockout.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Runtime note: this module touches Postgres, so it runs in the NODE runtime
 * only. `src/proxy.ts` runs at the edge and therefore logs rather than writing
 * here — the entry-point guard, which does run in Node, is what persists the
 * refusal.
 */

import { createHash } from 'node:crypto';

import { auditEvents } from '@/server/db/schema';
import { getDb } from '@/server/db';

/**
 * The complete set of audited events. A closed union rather than free strings,
 * so a typo cannot create a phantom event type that no query will ever find.
 */
export const AUDIT_EVENT = {
  SIGN_IN_SUCCESS: 'auth.sign_in.success',
  SIGN_IN_FAILURE: 'auth.sign_in.failure',
  /** A cryptographically VALID Access identity that is not the owner. */
  ACCESS_NON_OWNER: 'auth.access.non_owner',
  /** A request that reached a protected entry point without a valid session. */
  ENTRY_POINT_UNAUTHENTICATED: 'auth.entry_point.unauthenticated',
  ACCESS_MISCONFIGURED: 'auth.access.misconfigured',
  PASSKEY_ADDED: 'auth.passkey.added',
  PASSKEY_REMOVED: 'auth.passkey.removed',
  BOOTSTRAP_TOKEN_ISSUED: 'auth.bootstrap.token_issued',
  BOOTSTRAP_TOKEN_REDEEMED: 'auth.bootstrap.token_redeemed',
  BOOTSTRAP_TOKEN_REJECTED: 'auth.bootstrap.token_rejected',
  RECOVERY_TOKEN_ISSUED: 'auth.recovery.token_issued',
  RECOVERY_TOKEN_REDEEMED: 'auth.recovery.token_redeemed',
  RECOVERY_TOKEN_REJECTED: 'auth.recovery.token_rejected',
  SESSION_REVOKED: 'auth.session.revoked',
  REAUTH_SUCCESS: 'auth.reauth.success',
  REAUTH_FAILURE: 'auth.reauth.failure',
} as const;

export type AuditEventType = (typeof AUDIT_EVENT)[keyof typeof AUDIT_EVENT];

/**
 * Metadata is restricted to primitives on purpose. Nesting is how a whole
 * transaction row ends up in an audit record "temporarily".
 */
export type AuditMetadata = Readonly<Record<string, string | number | boolean | null>>;

export interface AuditEventInput {
  readonly eventType: AuditEventType;
  readonly ownerId?: string | null;
  readonly subjectType?: string | null;
  readonly subjectId?: string | null;
  readonly metadata?: AuditMetadata;
}

/**
 * A short, salt-free digest of an email address, for correlation only.
 *
 * Salt-free is intentional: the point is that two attempts by the same address
 * produce the same value. It is not a secrecy mechanism — the address space of
 * plausible emails is trivially searchable — it is a way to avoid *storing* an
 * address while still being able to say "the same one, eleven times".
 */
export function fingerprintEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);
}

/**
 * Record an audited event. Never throws.
 */
export async function recordAuditEvent(input: AuditEventInput): Promise<void> {
  try {
    await getDb()
      .insert(auditEvents)
      .values({
        eventType: input.eventType,
        ownerId: input.ownerId ?? null,
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        metadata: input.metadata ?? null,
      });
  } catch (cause) {
    // Structured, and carrying no metadata — the values that failed to insert
    // are the values we already decided not to put in a log.
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'audit_write_failed',
        eventType: input.eventType,
        error: cause instanceof Error ? cause.name : 'unknown',
      }),
    );
  }
}
