import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Access denied — Burmy' };

/**
 * Where `(private)/layout.tsx` sends an unauthenticated request.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS NOT A SIGN-IN SCREEN, AND IT MUST NEVER BECOME ONE.
 *
 * Cloudflare Access with Google is the sole authentication mechanism, enforced
 * BEFORE a request ever reaches this application (see docs/SECURITY.md). There
 * is no in-app credential to offer — no password, no passkey, no "try again"
 * that this page could meaningfully act on. Reaching this page in production
 * ordinarily means Access itself already let the request through (its policy
 * matched some Google account) but `requireOwner()` could not confirm it: the
 * verified email is not the owner, or the owner row has not been provisioned
 * yet (see scripts/provision-owner.mjs). Neither is fixable from a browser.
 *
 * No detail is shown about which of those it was, matching
 * `toAuthErrorResponse()`'s reasoning in src/server/auth/owner.ts: "which check
 * failed" is useful to an attacker probing the boundary and useless to the one
 * legitimate owner, who has the audit table.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export default function AccessDeniedPage(): React.ReactElement {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <p className="text-xs font-medium tracking-widest uppercase opacity-50">Burmy</p>
      <h1 className="mt-2 text-2xl font-semibold">Access denied</h1>
      <p className="mt-3 text-sm leading-relaxed opacity-70">
        This app is restricted to a single Google account, authenticated through
        Cloudflare Access. If you believe this is a mistake, the Access policy
        and the owner configuration are what to check — there is nothing to do
        from this page.
      </p>
    </main>
  );
}
