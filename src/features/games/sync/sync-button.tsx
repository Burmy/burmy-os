'use client';

import { Loader2, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { advanceSteamSyncAction, startSteamSyncAction } from './sync-actions';

type SyncState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'starting' }
  | { readonly phase: 'running'; readonly cursor: number; readonly total: number };

/**
 * "Sync with Steam" — the Library screen's only entry point into a sync run.
 *
 * `configured` is computed server-side (`isSteamConfiguredAction`, threaded
 * down from the Library page through `LibraryView`) rather than checked in
 * here: `STEAM_API_KEY`/`STEAM_ID` are server-only env vars, unreadable from
 * a Client Component, and resolving it up front avoids a flash between
 * "unknown" and "disabled." When `configured` is false the button renders
 * disabled with a standing, visible explanation — never hidden, and never a
 * thrown error.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROGRESS LOOP ONLY EVER BRANCHES ON `done`
 *
 * `advanceSteamSyncAction` reports `done: true` when a chunk comes back
 * empty — that is the ONLY termination signal (see that function's own doc
 * comment in `sync-actions.ts`). `cursor`/`total` are for the "N of M games
 * checked" label only; `total` is a count taken once at run creation and may
 * never be reached exactly (a game added or removed mid-run). Do not add a
 * `cursor >= total` check here — that is the exact bug an earlier fix round
 * removed from the engine, and reintroducing the comparison on the client
 * would strand a run at the same short-of-total / stuck-at-total spots.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function SyncButton({ configured }: { readonly configured: boolean }): React.ReactElement {
  const router = useRouter();
  const [state, setState] = useState<SyncState>({ phase: 'idle' });

  async function run(): Promise<void> {
    setState({ phase: 'starting' });

    const start = await startSteamSyncAction();
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
      const progress = await advanceSteamSyncAction(runId);
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
          Sync with Steam
        </Button>
        <p className="text-muted-foreground max-w-56 text-right text-xs text-balance">
          Set <code className="font-mono">STEAM_API_KEY</code> and <code className="font-mono">STEAM_ID</code> to
          enable Steam sync.
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
          : 'Sync with Steam'}
    </Button>
  );
}
