'use client';

import { KeyRound, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from '@/components/ui/toast';

import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';

export interface PasskeySummary {
  readonly id: string;
  readonly name: string | null;
  readonly createdAt: string | null;
}

/**
 * Passkey management.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SERVER ENFORCES EVERY RULE HERE. THIS UI ONLY EXPLAINS THEM.
 *
 * From M2 (src/server/auth/passkey-policy.ts):
 *   · Removal requires a FRESH session — 15 minutes since sign-in. Better Auth's
 *     own guard accepts any valid session, which would let someone with a
 *     borrowed unlocked laptop delete credentials.
 *   · The LAST passkey cannot be removed, because recovery deliberately requires
 *     Tailscale, an SSH key and a terminal, and a mis-click should not send the
 *     owner there.
 *
 * So the delete button is not disabled based on client state as the control — a
 * 403 comes back and is turned into a re-authentication prompt. Disabling it at
 * one remaining credential is a courtesy, not the rule.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function PasskeysManager({
  passkeys,
  minimum,
}: {
  readonly passkeys: readonly PasskeySummary[];
  readonly minimum: number;
}): React.ReactElement {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [needsReauth, setNeedsReauth] = useState(false);

  function enrol(): void {
    startTransition(async () => {
      const result = await authClient.passkey.addPasskey({
        name: `Passkey ${passkeys.length + 1}`,
      });

      if (result?.error) {
        toast.error(
          'That passkey was not added. If this device already has one enrolled, try a different device.',
        );
        return;
      }

      toast.success('Passkey added');
      router.refresh();
    });
  }

  function remove(passkey: PasskeySummary): void {
    startTransition(async () => {
      const result = await authClient.passkey.deletePasskey({ id: passkey.id });

      if (result?.error) {
        // 403 means the session is no longer fresh. Re-authenticating creates a
        // new session, which makes it fresh again — that is the whole mechanism.
        if (result.error.status === 403) {
          setNeedsReauth(true);
          return;
        }
        toast.error(result.error.message ?? 'Could not remove that passkey');
        return;
      }

      toast.success('Passkey removed');
      router.refresh();
    });
  }

  function reauthenticate(): void {
    startTransition(async () => {
      const result = await authClient.signIn.passkey();
      if (result?.error) {
        toast.error('Re-authentication failed');
        return;
      }
      setNeedsReauth(false);
      toast.success('Re-authenticated — you can now remove a passkey');
      router.refresh();
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Passkeys</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Burmy requires {minimum}. Use different devices so losing one is an inconvenience, not a
            recovery operation.
          </p>
        </div>
        <Button size="sm" onClick={enrol} disabled={pending}>
          <Plus className="size-4" />
          Add passkey
        </Button>
      </div>

      {needsReauth ? (
        <div className="mt-6 flex items-start gap-3 rounded-md border p-4">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium">Re-authentication required</p>
            <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
              Removing a credential needs a session less than 15 minutes old. Confirm with a passkey
              to continue.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={reauthenticate}
              disabled={pending}
            >
              Confirm with a passkey
            </Button>
          </div>
        </div>
      ) : null}

      <ul className="mt-6 divide-y border-t border-b">
        {passkeys.map((passkey) => (
          <li key={passkey.id} className="flex items-center gap-3 py-3">
            <KeyRound className="text-muted-foreground size-4" />
            <span className="flex-1 text-sm font-medium">{passkey.name ?? 'Passkey'}</span>
            <span className="text-muted-foreground text-xs">
              {passkey.createdAt ? new Date(passkey.createdAt).toLocaleDateString() : ''}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${passkey.name ?? 'passkey'}`}
              disabled={pending || passkeys.length <= 1}
              onClick={() => remove(passkey)}
            >
              <Trash2 className="size-4" />
            </Button>
          </li>
        ))}
      </ul>

      {passkeys.length <= 1 ? (
        <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
          The last passkey cannot be removed — enrol another first. This is enforced on the server,
          not just here.
        </p>
      ) : null}

      <p className="text-muted-foreground mt-8 text-xs leading-relaxed">
        Lost every passkey? Recovery runs from a terminal on the host:
        <code className="mx-1 font-mono">node scripts/auth-grant.mjs recovery</code>
        then redeem the token at <code className="font-mono">/recovery</code>. There is deliberately
        no emailed reset link.
      </p>
    </div>
  );
}
