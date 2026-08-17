'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { authClient } from '@/lib/auth-client';

/**
 * The passkey challenge.
 *
 * Errors are shown as one generic line on purpose. "No passkey found for this
 * device" versus "that credential is not the owner's" is a distinction useful
 * only to someone probing; the owner's next action is the same either way, and
 * the audit trail records what actually happened.
 */
export function SignInForm(): React.ReactElement {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'pending' | 'failed'>('idle');

  async function signIn(): Promise<void> {
    setState('pending');

    const result = await authClient.signIn.passkey();

    if (result?.error) {
      setState('failed');
      return;
    }

    // The onboarding gate lives on the server: if fewer than two passkeys are
    // enrolled, the private layout bounces this straight to onboarding. The
    // client does not decide.
    router.replace('/finance/monthly');
  }

  return (
    <div className="mt-8">
      <button
        type="button"
        onClick={() => void signIn()}
        disabled={state === 'pending'}
        className="w-full rounded-md border border-current/20 px-4 py-3 text-sm font-medium transition hover:bg-current/5 disabled:opacity-50"
      >
        {state === 'pending' ? 'Waiting for your passkey…' : 'Continue with a passkey'}
      </button>

      {state === 'failed' ? (
        <p role="alert" className="mt-4 text-sm opacity-70">
          That did not work. Try again, or use a device with an enrolled passkey.
        </p>
      ) : null}
    </div>
  );
}
