'use client';

import { Loader2, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { advancePsnSyncAction, startPsnSyncAction } from './psn-actions';

type SyncState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'starting' }
  | { readonly phase: 'running'; readonly cursor: number; readonly total: number };

/**
 * "Sync with PlayStation" — a SEPARATE entry point from `SyncButton`
 * (Steam), by the owner's explicit choice: a dead or expired PSN token must
 * never block a working Steam sync, so the two run independently rather
 * than behind one combined "sync everything" control.
 *
 * Structurally this is `SyncButton` pointed at the PSN engine, not a second
 * design — same server-computed `configured` prop (env vars are unreadable
 * from a Client Component), same start/advance loop, and the same "`done`
 * comes from an empty chunk, never `cursor >= total`" rule (see
 * `advancePsnSyncAction`'s own doc comment in `psn-actions.ts`, and
 * `SyncButton`'s matching comment for why that comparison must never come
 * back).
 *
 * `configured` only reflects whether `PSN_NPSSO` is SET, not whether it
 * still works — there is no way to check that without actually calling
 * Sony. A configured-but-expired token surfaces at click time as a
 * `startPsnSyncAction` failure, not as a disabled button: `psn-client.ts`'s
 * three-way `'not_configured' | 'token_expired' | 'unavailable'` contract
 * comes back as three differently-worded messages (see `psn-actions.ts`),
 * shown through the same `toast.error` path `SyncButton` already uses for
 * Steam's failures — never collapsed into one generic "sync failed" blob,
 * and never thrown.
 */
export function PsnSyncButton({ configured }: { readonly configured: boolean }): React.ReactElement {
  const router = useRouter();
  const [state, setState] = useState<SyncState>({ phase: 'idle' });

  async function run(): Promise<void> {
    setState({ phase: 'starting' });

    const start = await startPsnSyncAction();
    if (!start.ok) {
      toast.error(start.error);
      setState({ phase: 'idle' });
      return;
    }

    const runId = start.runId;
    if (runId === undefined) {
      toast.error('Sync could not start.');
      setState({ phase: 'idle' });
      return;
    }

    for (;;) {
      const progress = await advancePsnSyncAction(runId);
      if ('error' in progress) {
        toast.error(progress.error);
        setState({ phase: 'idle' });
        return;
      }

      setState({ phase: 'running', cursor: progress.cursor, total: progress.total });
      if (progress.done) break;
    }

    router.push(`/games/sync/${runId}`);
  }

  if (!configured) {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button size="sm" variant="outline" disabled>
          <RefreshCw className="size-4" aria-hidden />
          Sync with PlayStation
        </Button>
        <p className="text-muted-foreground max-w-56 text-right text-xs text-balance">
          Set <code className="font-mono">PSN_NPSSO</code> to enable PlayStation sync.
        </p>
      </div>
    );
  }

  const busy = state.phase !== 'idle';

  return (
    <Button size="sm" variant="outline" onClick={run} disabled={busy}>
      {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
      {state.phase === 'running'
        ? `${state.cursor} of ${state.total} games checked`
        : state.phase === 'starting'
          ? 'Starting…'
          : 'Sync with PlayStation'}
    </Button>
  );
}
