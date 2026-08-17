import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { PasskeyEnrolment } from '@/features/auth/passkey-enrolment';
import {
  MIN_PASSKEYS,
  SecurityUnavailableError,
  UnauthorizedError,
  requireOwner,
} from '@/server/auth/owner';

export const metadata: Metadata = { title: 'Set up passkeys — Burmy' };

/**
 * The two-passkey onboarding gate.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS LIVES IN ITS OWN ROUTE GROUP
 *
 * `(private)` redirects HERE when onboarding is incomplete. If this page also
 * sat under that layout it would redirect to itself forever. So it has its own
 * group and passes `allowOnboarding: true` — the single caller permitted to do
 * so, which is why that option is named for the thing it allows rather than
 * something vague like `skipChecks`.
 *
 * WHY TWO
 *
 * One passkey is a single point of failure, and Burmy's recovery path
 * deliberately requires Tailscale membership, an SSH key and a terminal.
 * Enrolling a second credential costs twenty seconds while already
 * authenticated, and it is the difference between "lost my phone" and
 * "invoke break-glass". Enforced in `requireOwner()`, not here — this page is
 * the explanation, not the control.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export default async function OnboardingPasskeysPage(): Promise<React.ReactElement> {
  let passkeyCount = 0;
  let destination: string | null = null;

  try {
    const context = await requireOwner({ allowOnboarding: true });
    passkeyCount = context.passkeyCount;
    if (context.onboardingComplete) destination = '/finance/monthly';
  } catch (error) {
    if (error instanceof UnauthorizedError) destination = '/sign-in';
    else if (error instanceof SecurityUnavailableError) throw error;
    else throw error;
  }

  if (destination) redirect(destination);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <p className="text-xs font-medium tracking-widest uppercase opacity-50">Burmy</p>
      <h1 className="mt-2 text-2xl font-semibold">Set up your passkeys</h1>

      <p className="mt-3 text-sm leading-relaxed opacity-70">
        Burmy needs {MIN_PASSKEYS} passkeys enrolled before it will let you in.
        Use two different devices — a phone and this computer, say — so that
        losing one is an inconvenience rather than a recovery operation.
      </p>

      <PasskeyEnrolment initialCount={passkeyCount} required={MIN_PASSKEYS} />

      <p className="mt-10 text-xs leading-relaxed opacity-50">
        If you lose all of them, recovery is a script run over SSH on the host.
        It works, and it is meant to be inconvenient. That is the trade for
        having no emailed reset link to phish.
      </p>
    </main>
  );
}
