import type { Metadata } from 'next';

import { SignInForm } from '@/features/auth/sign-in-form';

export const metadata: Metadata = { title: 'Sign in — Burmy' };

/**
 * Passkey sign-in — FACTOR 2.
 *
 * Reaching this page at all means Cloudflare Access already established the
 * owner's Google identity (factor 1). There is no email field and no password
 * field, because there is no email or password credential: the passkey IS the
 * credential, and WebAuthn's discoverable credentials mean the browser already
 * knows which one to offer.
 *
 * There is no "create an account" link. There is no signup route to link to.
 */
export default function SignInPage(): React.ReactElement {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <p className="text-xs font-medium tracking-widest uppercase opacity-50">Burmy</p>
      <h1 className="mt-2 text-2xl font-semibold">Sign in</h1>
      <p className="mt-3 text-sm leading-relaxed opacity-70">
        Use the passkey on this device.
      </p>

      <SignInForm />

      <p className="mt-10 text-xs leading-relaxed opacity-50">
        Lost every passkey? Recovery runs from a terminal on the host, not from
        this page — see <span className="font-mono">docs/SECURITY.md</span>.
      </p>
    </main>
  );
}
