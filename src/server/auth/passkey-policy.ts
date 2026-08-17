/**
 * Better Auth plugin: Burmy's policy on top of the passkey plugin.
 *
 * The passkey plugin is deliberately generic. Three things Burmy needs are
 * therefore not its defaults, and all three must be enforced SERVER-SIDE — a
 * disabled button is a UI preference, not a control.
 *
 *   1. REMOVING a passkey is a sensitive action and requires a FRESH session.
 *      Better Auth guards `/passkey/delete-passkey` with `sessionMiddleware`,
 *      which accepts any valid session — including a week-old one on a device
 *      that walked away. Deleting a credential is exactly the operation an
 *      opportunist performs with a borrowed unlocked laptop.
 *
 *   2. The LAST passkey cannot be deleted. Burmy's recovery path intentionally
 *      requires Tailscale membership, an SSH key and a terminal; a single
 *      mis-click should not be able to send the owner there. Going from two
 *      passkeys to one is allowed — the onboarding gate then asks for a
 *      replacement — but going to zero is refused.
 *
 *   3. Sign-in, enrolment and removal are audited.
 *
 * A note on hook ordering: `before` hooks run prior to the endpoint, so throwing
 * there prevents the deletion rather than reporting it afterwards.
 */

import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';

import { AUDIT_EVENT, recordAuditEvent } from '@/server/security/audit';

const DELETE_PASSKEY_PATH = '/passkey/delete-passkey';
const VERIFY_REGISTRATION_PATH = '/passkey/verify-registration';
const VERIFY_AUTHENTICATION_PATH = '/passkey/verify-authentication';

/** Matches `session.freshAge` in the Better Auth options. */
const FRESH_AGE_MS = 60 * 15 * 1000;

export const burmyPasskeyPolicy = () =>
  ({
    id: 'burmy-passkey-policy',

    hooks: {
      before: [
        {
          matcher: (context) => context.path === DELETE_PASSKEY_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const result = await getSessionFromCtx(ctx);
            if (!result?.session) {
              throw new APIError('UNAUTHORIZED', { message: 'Unauthorized' });
            }

            // ── (1) Re-authentication ──────────────────────────────────────
            const createdAt = new Date(result.session.createdAt).getTime();
            if (Date.now() - createdAt >= FRESH_AGE_MS) {
              await recordAuditEvent({
                eventType: AUDIT_EVENT.REAUTH_FAILURE,
                ownerId: result.user?.id ?? null,
                subjectType: 'passkey_delete',
              });
              throw new APIError('FORBIDDEN', { message: 'Re-authentication required' });
            }

            // ── (2) Never delete the last credential ────────────────────────
            const userId = result.user?.id;
            if (userId) {
              const remaining = await ctx.context.adapter.findMany({
                model: 'passkey',
                where: [{ field: 'userId', value: userId }],
              });
              if (remaining.length <= 1) {
                throw new APIError('BAD_REQUEST', {
                  message: 'Cannot remove the only passkey. Enrol another first.',
                });
              }
            }

            await recordAuditEvent({
              eventType: AUDIT_EVENT.REAUTH_SUCCESS,
              ownerId: userId ?? null,
              subjectType: 'passkey_delete',
            });
          }),
        },
      ],

      after: [
        {
          matcher: (context) => context.path === VERIFY_REGISTRATION_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            // `returned` is an APIError when the endpoint failed; only a
            // successful enrolment is worth an "added" record, and failures are
            // already audited by their own paths.
            if (ctx.context.returned instanceof APIError) return;
            await recordAuditEvent({
              eventType: AUDIT_EVENT.PASSKEY_ADDED,
              subjectType: 'passkey',
            });
          }),
        },
        {
          matcher: (context) => context.path === DELETE_PASSKEY_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.context.returned instanceof APIError) return;
            await recordAuditEvent({
              eventType: AUDIT_EVENT.PASSKEY_REMOVED,
              subjectType: 'passkey',
            });
          }),
        },
        {
          matcher: (context) => context.path === VERIFY_AUTHENTICATION_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const failed = ctx.context.returned instanceof APIError;
            await recordAuditEvent({
              eventType: failed ? AUDIT_EVENT.SIGN_IN_FAILURE : AUDIT_EVENT.SIGN_IN_SUCCESS,
              subjectType: 'passkey',
            });
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
