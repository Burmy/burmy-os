'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Redeem a bootstrap or recovery grant.
 *
 * Posts to `/api/auth/burmy/redeem-grant` with `fetch` rather than through the
 * Better Auth client, because this endpoint is a Burmy plugin and there is no
 * generated client action for it. `credentials: 'same-origin'` matters: the
 * response's whole payload is a `Set-Cookie`.
 */
export function GrantRedemptionForm(): React.ReactElement {
  const router = useRouter();
  const [token, setToken] = useState('');
  const [kind, setKind] = useState<'bootstrap' | 'recovery'>('recovery');
  const [state, setState] = useState<'idle' | 'pending' | 'failed' | 'rate-limited'>('idle');

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setState('pending');

    const response = await fetch('/api/auth/burmy/redeem-grant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ token: token.trim(), kind }),
    });

    if (response.status === 429) {
      setState('rate-limited');
      return;
    }

    if (!response.ok) {
      setState('failed');
      return;
    }

    // A redeemed grant always lands on onboarding: after recovery there are zero
    // usable passkeys, and the gate will insist on two before anything else.
    router.replace('/onboarding/passkeys');
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="mt-8">
      <fieldset className="flex gap-4 text-sm">
        <legend className="sr-only">Grant type</legend>
        {(['recovery', 'bootstrap'] as const).map((option) => (
          <label key={option} className="flex items-center gap-2">
            <input
              type="radio"
              name="kind"
              value={option}
              checked={kind === option}
              onChange={() => setKind(option)}
            />
            <span className="capitalize">{option}</span>
          </label>
        ))}
      </fieldset>

      <label htmlFor="grant-token" className="mt-6 block text-sm font-medium">
        Token
      </label>
      <input
        id="grant-token"
        name="token"
        type="password"
        required
        autoComplete="off"
        spellCheck={false}
        value={token}
        onChange={(event) => setToken(event.target.value)}
        className="mt-2 w-full rounded-md border border-current/20 bg-transparent px-3 py-2 font-mono text-sm"
      />

      <button
        type="submit"
        disabled={state === 'pending' || token.trim() === ''}
        className="mt-4 w-full rounded-md border border-current px-4 py-3 text-sm font-medium transition hover:bg-current/5 disabled:opacity-50"
      >
        {state === 'pending' ? 'Redeeming…' : 'Redeem'}
      </button>

      {state === 'failed' ? (
        <p role="alert" className="mt-4 text-sm opacity-70">
          That token was not accepted. It may have expired, already been used, or
          be the wrong type. Mint a fresh one on the host.
        </p>
      ) : null}

      {state === 'rate-limited' ? (
        <p role="alert" className="mt-4 text-sm opacity-70">
          Too many attempts. This endpoint allows five per hour, and the limit is
          stored in the database — restarting the app will not clear it.
        </p>
      ) : null}
    </form>
  );
}
