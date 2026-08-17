import type { Metadata } from 'next';

import { GrantRedemptionForm } from '@/features/auth/grant-redemption-form';

export const metadata: Metadata = { title: 'Recovery — Burmy' };

/**
 * Break-glass recovery, and first-run bootstrap.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * This page CANNOT issue a token. It only accepts one that was minted on the
 * host by `node scripts/auth-grant.mjs`, over SSH through Tailscale.
 *
 * That asymmetry is the design. There is no "email me a link", no security
 * questions, no phone number — every one of those is a phishable path around the
 * passkey, permanently available to anyone who can reach the page. Requiring the
 * operator to hold an SSH key and shell access means the recovery path's strength
 * does not depend on the owner never being fooled.
 *
 * Reaching this page still requires passing Cloudflare Access as the owner, and
 * the redemption endpoint verifies that itself rather than trusting the proxy.
 * So recovery needs: the Google identity, AND host access. Losing every passkey
 * costs neither of those.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export default function RecoveryPage(): React.ReactElement {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <p className="text-xs font-medium tracking-widest uppercase opacity-50">Burmy</p>
      <h1 className="mt-2 text-2xl font-semibold">Recovery</h1>

      <p className="mt-3 text-sm leading-relaxed opacity-70">
        Paste the token printed by the grant script. It is valid for ten minutes
        and works exactly once.
      </p>

      <GrantRedemptionForm />

      <div className="mt-10 text-xs leading-relaxed opacity-50">
        <p>On the host, over Tailscale:</p>
        <pre className="mt-2 overflow-x-auto rounded-md border border-current/15 p-3 font-mono">
          node scripts/auth-grant.mjs recovery
        </pre>
        <p className="mt-3">
          Use <span className="font-mono">bootstrap</span> instead of{' '}
          <span className="font-mono">recovery</span> for the very first passkey.
        </p>
      </div>
    </main>
  );
}
