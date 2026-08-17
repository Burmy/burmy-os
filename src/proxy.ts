import { type NextRequest, NextResponse } from 'next/server';

import {
  AccessDeniedError,
  AccessMisconfiguredError,
  readAccessToken,
  resolveAccessMode,
  verifyAccessToken,
} from '@/server/auth/access';
import { NONCE_HEADER, buildCsp, generateNonce } from '@/server/security/csp';

/**
 * Request proxy — formerly `middleware`, renamed in Next.js 16.
 *
 * MUST live at `src/proxy.ts`, level with `app/` — not inside it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS DEFENSE-IN-DEPTH, NOT THE SECURITY BOUNDARY.
 *
 * Next.js documents that Server Functions are handled as POSTs to the route
 * where they are used, so a `matcher` change — or refactoring an action to a
 * different route — can SILENTLY remove proxy coverage, with no error and no
 * failing test.
 *
 * Therefore every protected server entry point (Server Action and Route
 * Handler alike) authenticates itself via `requireOwner()`, which verifies BOTH
 * factors on its own. Never rely on this file alone. See docs/SECURITY.md.
 *
 * WHAT THIS FILE UNIQUELY PROVIDES
 *
 * Two things that cannot be done anywhere else:
 *
 *   1. A per-request CSP nonce. `next.config.ts` `headers()` emits static
 *      strings, so a nonce is not expressible there.
 *   2. Refusal of un-Accessed traffic BEFORE it reaches application code, which
 *      is what protects the origin if the tunnel is ever bypassed.
 *
 * RUNTIME
 *
 * The proxy runs in the EDGE runtime — Next.js 16.3 exposes no runtime option
 * for it (`MiddlewareConfigInput` accepts only `matcher`, `regions` and
 * `unstable_allowDynamic`). Consequences, both deliberate:
 *
 *   · Only edge-safe code may be imported here. `jose` verifies with WebCrypto
 *     and is fine; anything touching Postgres or `node:crypto` is not — which is
 *     why refusals are LOGGED here and persisted to `audit_events` by the Node-
 *     side guard instead.
 *   · A rejected request must not cost a database write. Auditing every probe
 *     from the proxy would turn a flood into write amplification against the
 *     database it is meant to protect.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * The container healthcheck and `deploy.sh` reach this from INSIDE the Docker
 * network, carrying no Access assertion — there is no browser and no Cloudflare
 * in that path. Requiring factor 1 here would mark every container unhealthy and
 * make every deploy roll itself back.
 *
 * Safe because the endpoint answers with booleans and a version string only. It
 * is the one intentional hole in factor 1, and it is one value wide.
 */
const ACCESS_EXEMPT_PATHS = new Set(['/api/health']);

/** Structured, redacted, and carrying no token material. */
function logRefusal(reason: string, request: NextRequest): void {
  console.warn(
    JSON.stringify({
      level: 'warn',
      msg: 'proxy_refused',
      reason,
      // Path only. No query string — it can carry a grant token — and no
      // headers, cookies or body.
      path: new URL(request.url).pathname,
      method: request.method,
    }),
  );
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = new URL(request.url);

  const nonce = generateNonce();
  const csp = buildCsp({ nonce, development: process.env.NODE_ENV === 'development' });

  // ── Factor 1: Cloudflare Access ─────────────────────────────────────────────
  if (!ACCESS_EXEMPT_PATHS.has(pathname)) {
    let mode;
    try {
      mode = resolveAccessMode();
    } catch (cause) {
      if (cause instanceof AccessMisconfiguredError) {
        // FAIL CLOSED. A deployment that cannot verify factor 1 serves nothing.
        // An outage is recoverable in minutes; an origin quietly serving
        // unauthenticated financial data is not.
        logRefusal('access_misconfigured', request);
        return new NextResponse(null, { status: 503 }) as NextResponse;
      }
      throw cause;
    }

    if (mode.kind === 'enforced') {
      try {
        await verifyAccessToken(readAccessToken(request.headers), mode.config);
      } catch (cause) {
        if (cause instanceof AccessDeniedError) {
          logRefusal('access_denied', request);
          // 403, not 401: there is no `WWW-Authenticate` challenge the browser
          // could satisfy here. Re-authentication happens at Cloudflare.
          return new NextResponse(null, { status: 403 }) as NextResponse;
        }
        throw cause;
      }
    }
  }

  // ── Forward, carrying the nonce inward ─────────────────────────────────────
  const requestHeaders = new Headers(request.headers);

  // Overwritten unconditionally, so a client-supplied `x-nonce` can never be
  // the value a Server Component renders with.
  requestHeaders.set(NONCE_HEADER, nonce);

  // Next.js parses the nonce out of the CSP on the REQUEST to nonce its own
  // script tags. Setting it only on the response would leave the framework's
  // own scripts unnonced, and a strict policy would then block the application
  // it is protecting.
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);

  return response;
}

export const config = {
  /**
   * Match everything except static assets and image optimization.
   *
   * `/api/*` is deliberately NOT excluded: Route Handlers are protected
   * endpoints too, and excluding them here is precisely the silent-coverage-gap
   * the note above warns about.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)'],
};
