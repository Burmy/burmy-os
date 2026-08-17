'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { authClient } from '@/lib/auth-client';

interface Props {
  readonly initialCount: number;
  readonly required: number;
}

/**
 * Enrol passkeys until the server's gate is satisfied.
 *
 * The count shown here comes from the server on first render and is incremented
 * optimistically after each successful ceremony. It is a PROGRESS INDICATOR, not
 * a gate: the actual decision is `requireOwner()`'s, re-evaluated on the
 * navigation below. A client that lied about having two passkeys would simply be
 * bounced back here.
 */
export function PasskeyEnrolment({ initialCount, required }: Props): React.ReactElement {
  const router = useRouter();
  const [count, setCount] = useState(initialCount);
  const [state, setState] = useState<'idle' | 'pending' | 'failed'>('idle');

  async function enrol(): Promise<void> {
    setState('pending');

    const result = await authClient.passkey.addPasskey({
      // A label the owner can recognize later. The AAGUID gives a provider name
      // for common authenticators, but not a device.
      name: `Passkey ${count + 1}`,
    });

    if (result?.error) {
      setState('failed');
      return;
    }

    setState('idle');
    setCount((previous) => previous + 1);
  }

  const remaining = Math.max(0, required - count);

  return (
    <div className="mt-8">
      <p className="text-sm tabular-nums">
        <span className="font-semibold">{count}</span>
        <span className="opacity-60"> of {required} enrolled</span>
      </p>

      <button
        type="button"
        onClick={() => void enrol()}
        disabled={state === 'pending'}
        className="mt-4 w-full rounded-md border border-current/20 px-4 py-3 text-sm font-medium transition hover:bg-current/5 disabled:opacity-50"
      >
        {state === 'pending' ? 'Waiting for your device…' : 'Add a passkey'}
      </button>

      {state === 'failed' ? (
        <p role="alert" className="mt-4 text-sm opacity-70">
          That passkey was not added. If this device already has one enrolled,
          try a different device.
        </p>
      ) : null}

      {remaining === 0 ? (
        <button
          type="button"
          onClick={() => router.replace('/finance/monthly')}
          className="mt-3 w-full rounded-md border border-current px-4 py-3 text-sm font-medium transition hover:bg-current/5"
        >
          Continue to Burmy
        </button>
      ) : (
        <p className="mt-4 text-xs opacity-50">
          {remaining} more to go. Use a different device for this one.
        </p>
      )}
    </div>
  );
}
