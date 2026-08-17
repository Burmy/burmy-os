/**
 * Better Auth plugin: out-of-band grant redemption.
 *
 * Mounts `POST /api/auth/burmy/redeem-grant`, which turns a grant token minted
 * by `scripts/auth-grant.mjs` into a session.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A PLUGIN AND NOT A PLAIN ROUTE HANDLER
 *
 * Because creating a session correctly is not a small job. Better Auth's own
 * sign-in path calls `internalAdapter.createSession()` and then
 * `setSessionCookie()`, which signs the cookie with the instance secret and
 * applies the configured attributes. A hand-rolled Route Handler would have to
 * reproduce that signing, and a bug there would be a silent authentication
 * bypass. Living inside the plugin system means this endpoint uses the SAME
 * session machinery as passkey sign-in — and inherits Better Auth's rate limiter
 * rather than needing its own.
 *
 * It also means the endpoint sits under `/api/auth/*`, which is already the
 * enumerated unprotected allowlist. It has to be reachable without a session:
 * being unable to authenticate is the situation it exists for.
 *
 * WHAT STILL GUARDS IT
 *
 *   1. Cloudflare Access (factor 1) is verified HERE, not merely upstream. A
 *      lost passkey does not cost the owner their Google account, so requiring
 *      factor 1 during recovery costs nothing and means a leaked token alone is
 *      not sufficient.
 *   2. The token is single-use and expires in ten minutes — enforced by
 *      `consumeVerificationValue`, atomically, inside a transaction.
 *   3. The grant's `kind` must match the requested operation, so a bootstrap
 *      token cannot be replayed as a recovery token.
 *   4. A `bootstrap` grant is refused once any passkey exists, so a forgotten
 *      token cannot become a permanent side door.
 *   5. Every outcome — issued, redeemed, rejected — is audited.
 *   6. Rate limited well below brute-force viability (see `rateLimit` below).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import * as z from 'zod';

import { AUDIT_EVENT, fingerprintEmail, recordAuditEvent } from '@/server/security/audit';
import {
  AccessDeniedError,
  AccessMisconfiguredError,
  isOwnerEmail,
  ownerEmail,
  requireAccessIdentity,
} from './access';
import { decodeGrantPayload, grantIdentifier, grantKindMatches } from './grants';

export const REDEEM_GRANT_PATH = '/burmy/redeem-grant';

const redeemBody = z.object({
  token: z.string().min(1).max(512),
  kind: z.enum(['bootstrap', 'recovery']),
});

/**
 * A single generic failure for every rejection reason.
 *
 * Distinguishing "no such token" from "wrong kind" from "already used" would
 * hand an attacker a probing oracle. The audit trail records which it was; the
 * response never does.
 */
function rejected(): APIError {
  return new APIError('UNAUTHORIZED', { message: 'Grant could not be redeemed' });
}

export const burmyGrants = () =>
  ({
    id: 'burmy-grants',

    /**
     * Five attempts per hour.
     *
     * A grant token is 256 bits of randomness, so brute force was never the
     * realistic threat — this bounds *replay and probing* noise against the one
     * endpoint that can mint a session without a passkey, and it is backed by the
     * `rate_limit` TABLE so a container restart does not clear it.
     */
    rateLimit: [
      {
        pathMatcher: (path: string) => path === REDEEM_GRANT_PATH,
        window: 3600,
        max: 5,
      },
    ],

    endpoints: {
      burmyRedeemGrant: createAuthEndpoint(
        REDEEM_GRANT_PATH,
        {
          method: 'POST',
          body: redeemBody,
          metadata: {
            openapi: {
              operationId: 'burmyRedeemGrant',
              description:
                'Redeem an out-of-band bootstrap or recovery grant for a session. ' +
                'Tokens are minted only by scripts/auth-grant.mjs over Tailscale/SSH.',
            },
          },
        },
        async (ctx) => {
          const { token, kind } = ctx.body;

          // ── Factor 1 ───────────────────────────────────────────────────────
          // Verified here rather than trusted from the proxy, because this is
          // the endpoint that hands out sessions.
          let accessEmail: string;
          try {
            const identity = await requireAccessIdentity(ctx.headers ?? new Headers());
            accessEmail = identity.email;
          } catch (cause) {
            if (cause instanceof AccessMisconfiguredError) {
              await recordAuditEvent({
                eventType: AUDIT_EVENT.ACCESS_MISCONFIGURED,
                subjectType: 'grant',
                metadata: { path: REDEEM_GRANT_PATH },
              });
              throw new APIError('SERVICE_UNAVAILABLE', { message: 'Unavailable' });
            }
            if (cause instanceof AccessDeniedError) {
              await recordAuditEvent({
                eventType: AUDIT_EVENT.SIGN_IN_FAILURE,
                subjectType: 'grant',
                metadata: { kind, reason: 'access_denied' },
              });
              throw rejected();
            }
            throw cause;
          }

          const auditRejection = async (reason: string): Promise<never> => {
            await recordAuditEvent({
              eventType:
                kind === 'bootstrap'
                  ? AUDIT_EVENT.BOOTSTRAP_TOKEN_REJECTED
                  : AUDIT_EVENT.RECOVERY_TOKEN_REJECTED,
              subjectType: 'grant',
              metadata: { kind, reason, emailFingerprint: fingerprintEmail(accessEmail) },
            });
            throw rejected();
          };

          // ── Consume the grant: atomic, single-use, TTL-checked upstream ─────
          const consumed = await ctx.context.internalAdapter.consumeVerificationValue(
            grantIdentifier(token),
          );
          if (!consumed) return auditRejection('unknown_or_expired');

          const payload = decodeGrantPayload(consumed.value);
          if (!payload) return auditRejection('malformed_payload');
          if (!grantKindMatches(kind, payload.kind)) return auditRejection('kind_mismatch');
          if (!isOwnerEmail(payload.email)) return auditRejection('not_owner');
          if (!isOwnerEmail(accessEmail)) return auditRejection('access_not_owner');

          // ── Resolve the owner row ──────────────────────────────────────────
          // `findUserByEmail` resolves to `{ user, accounts } | null`, not to a
          // user — unwrap it rather than trusting the name.
          const email = ownerEmail();
          const found = await ctx.context.internalAdapter.findUserByEmail(email);
          let user = found?.user ?? null;

          if (!user) {
            if (kind !== 'bootstrap') return auditRejection('no_owner_to_recover');

            const created = await ctx.context.internalAdapter.createUser({
              email,
              name: email,
              // The Access-verified Google identity is the proof of this email.
              // Better Auth never emails from this app, so there is nothing to
              // verify and no verification mail to phish.
              emailVerified: true,
            });
            if (!created) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Unavailable' });
            user = created;
          } else if (kind === 'bootstrap') {
            // Bootstrap is a once-ever operation. Anything after the first
            // passkey exists is recovery, and must use a recovery grant.
            const existing = await ctx.context.adapter.findMany({
              model: 'passkey',
              where: [{ field: 'userId', value: user.id }],
              limit: 1,
            });
            if (existing.length > 0) return auditRejection('bootstrap_after_enrollment');
          }

          if (!isOwnerEmail(user.email)) return auditRejection('resolved_user_not_owner');

          // ── Recovery kills stale sessions ──────────────────────────────────
          // The owner is here because their credentials are gone; any session
          // still alive is either forgotten or not theirs. Bootstrap skips this:
          // there is nothing to revoke on a first run.
          if (kind === 'recovery') {
            // `deleteUserSessions(userId)`, NOT `deleteSessions(...)` — the
            // latter takes session TOKENS, and passing a user id there would
            // match nothing and silently revoke none of them.
            await ctx.context.internalAdapter.deleteUserSessions(user.id);
            await recordAuditEvent({
              eventType: AUDIT_EVENT.SESSION_REVOKED,
              ownerId: user.id,
              subjectType: 'recovery',
              metadata: { scope: 'all_sessions' },
            });
          }

          const session = await ctx.context.internalAdapter.createSession(user.id);
          if (!session) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Unavailable' });

          await setSessionCookie(ctx, { session, user });

          await recordAuditEvent({
            eventType:
              kind === 'bootstrap'
                ? AUDIT_EVENT.BOOTSTRAP_TOKEN_REDEEMED
                : AUDIT_EVENT.RECOVERY_TOKEN_REDEEMED,
            ownerId: user.id,
            subjectType: 'grant',
            metadata: { kind, issuedAt: payload.issuedAt },
          });

          // The session cookie is the payload. Deliberately no token in the
          // body: this response may be read by a browser fetch, and there is no
          // cross-domain handoff to justify exposing it.
          return ctx.json({ ok: true, redirect: '/onboarding/passkeys' }, { status: 200 });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
