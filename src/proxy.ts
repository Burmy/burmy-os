import { type NextRequest, NextResponse } from 'next/server';

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
 * Handler alike) authenticates itself via `requireOwner()`. Never rely on this
 * file alone. See docs/SECURITY.md.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Milestone 2 adds: Cloudflare Access JWT verification against the JWKS
 * (signature, `aud`, `iss`, `exp`) and a nonce-based CSP, which needs
 * per-request state that static headers in next.config.ts cannot express.
 */
export function proxy(_request: NextRequest): NextResponse {
  return NextResponse.next();
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
