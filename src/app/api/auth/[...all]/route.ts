/**
 * Better Auth's own endpoints.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS THE SECOND AND LAST UNAUTHENTICATED ROUTE IN BURMY.
 * (The other is /api/health.)
 *
 * It does NOT call `requireOwner()`, and that is correct rather than an
 * oversight: these are the flows that establish a session in the first place. A
 * guard here would make signing in require being signed in.
 *
 * Authorization is enforced INSIDE the handlers instead:
 *   · passkey sign-in verifies a WebAuthn assertion against a stored credential;
 *   · adding or removing a passkey requires a session, and removal additionally
 *     requires a FRESH one (src/server/auth/passkey-policy.ts);
 *   · grant redemption verifies Cloudflare Access, a single-use short-lived
 *     token, and the owner allowlist (src/server/auth/grant-plugin.ts);
 *   · every path is rate limited, with counters in Postgres.
 *
 * Adding an endpoint to this router therefore means adding it to the
 * unauthenticated attack surface. tests/integration/entry-points.test.ts asserts
 * that the allowlist is exactly these two routes and nothing else.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getAuth } from '@/server/auth';

// Better Auth talks to Postgres and uses node:crypto — it cannot run at the edge.
export const runtime = 'nodejs';

// Auth responses are per-request and must never be cached or prerendered.
export const dynamic = 'force-dynamic';

/**
 * `getAuth()` is called INSIDE each handler, never at module scope.
 *
 * The obvious spelling — `export const { GET, POST } = toNextJsHandler(auth.handler)`
 * — reads `auth.handler` while the module is being evaluated, which constructs
 * Better Auth (and therefore the database adapter) at import time. `next build`
 * imports every route module to collect its configuration, so that spelling
 * makes a production build require `DATABASE_URL` and `BETTER_AUTH_SECRET` to be
 * present at BUILD time. They are injected at RUN time via `env_file`.
 *
 * Verified, not theorised: the destructured version failed the build with
 * "Failed to collect configuration for /api/auth/[...all]".
 *
 * Only GET and POST are exported. Every Better Auth endpoint in use — including
 * the passkey plugin's and Burmy's grant redemption — declares one of those two,
 * so the other verbs would add unauthenticated surface for no behaviour.
 */
export async function GET(request: Request): Promise<Response> {
  return getAuth().handler(request);
}

export async function POST(request: Request): Promise<Response> {
  return getAuth().handler(request);
}
