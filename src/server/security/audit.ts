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
 *   - No tokens, no cookies, no Access assertions.
 *   - A rejected request's email is never captured at all, not even as a hash:
 *     `requireAccessIdentity()` in `server/auth/access.ts` rejects a
 *     non-owner identity before returning it to any caller, so there is no
 *     candidate email available here to record in the first place. A non-owner
 *     email would be someone else's PII sitting in a personal finance database.
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

import { auditEvents } from '@/server/db/schema';
import { getDb } from '@/server/db';

/**
 * The complete set of audited events. A closed union rather than free strings,
 * so a typo cannot create a phantom event type that no query will ever find.
 */
export const AUDIT_EVENT = {
  /**
   * A request reached a protected entry point without a valid, owner-matched
   * Access identity — `metadata.reason` distinguishes "no/invalid assertion"
   * (`access_denied`, from Cloudflare Access itself) from "verified as the
   * owner, but no database row exists yet" (`owner_not_provisioned`).
   */
  ENTRY_POINT_UNAUTHENTICATED: 'auth.entry_point.unauthenticated',
  /** The deployment cannot verify Cloudflare Access — missing/invalid config. */
  ACCESS_MISCONFIGURED: 'auth.access.misconfigured',
} as const;

type AuditEventType = (typeof AUDIT_EVENT)[keyof typeof AUDIT_EVENT];

/**
 * Metadata is restricted to primitives on purpose. Nesting is how a whole
 * transaction row ends up in an audit record "temporarily".
 */
type AuditMetadata = Readonly<Record<string, string | number | boolean | null>>;

export interface AuditEventInput {
  readonly eventType: AuditEventType;
  readonly ownerId?: string | null;
  readonly subjectType?: string | null;
  readonly subjectId?: string | null;
  readonly metadata?: AuditMetadata;
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
