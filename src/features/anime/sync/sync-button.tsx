'use client';

import { Loader2, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { advanceAnimeSyncAction, startAnimeSyncAction } from './sync-actions';

type SyncState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'starting' }
  | { readonly phase: 'running'; readonly cursor: number; readonly total: number };

/**
 * "Sync with AniList" — the only entry point into an anime sync run.
 *
 * `configured` is resolved server-side (`isAnilistConfiguredAction`, called by
 * the Settings page) rather than checked here: `ANILIST_USERNAME` is a
 * server-only env var, unreadable from a Client Component, and resolving it up
 * front avoids a flash between "unknown" and "disabled". When it is false the
 * button renders DISABLED WITH A VISIBLE REASON — never hidden, never thrown.
 * Same contract `SyncButton` (Steam) and `PsnSyncButton` both follow.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROGRESS LOOP ONLY EVER BRANCHES ON `done`.
 *
 * `advanceAnimeSyncAction` reports `done: true` when a chunk comes back EMPTY;
 * that is the only termination signal (its own doc comment says why, and the
 * two bugs it names were reproduced against real Postgres in the Games
 * engine). `cursor`/`total` drive the label and nothing else — `total` is a
 * count taken once at run creation and may never be reached exactly. Do not
 * add a `cursor >= total` check here either: putting the comparison on the
 * client strands a run in exactly the same two places.
 *
 * There is no enrichment phase, unlike Steam's. AniList returns cover art,
 * studio, genres and synopsis inside the same list response, so a second pass
 * would have nothing left to fetch.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function AnimeSyncButton({ configured }: { readonly configured: boolean }): React.ReactElement {
  const router = useRouter();
  const [state, setState] = useState<SyncState>({ phase: 'idle' });

  async function run(): Promise<void> {
    setState({ phase: 'starting' });

    const start = await startAnimeSyncAction();
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
      const progress = await advanceAnimeSyncAction(runId);
      if ('error' in progress) {
        toast.error(progress.error);
        setState({ phase: 'idle' });
        return;
      }

      setState({ phase: 'running', cursor: progress.cursor, total: progress.total });
      if (progress.done) break;
    }

    router.push(`/anime/sync/${runId}`);
  }

  if (!configured) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled title="Set ANILIST_USERNAME to enable AniList sync.">
          <RefreshCw className="size-4" aria-hidden />
          Sync with AniList
        </Button>
        <p className="text-muted-foreground text-xs">
          Needs <code className="font-mono">ANILIST_USERNAME</code>
        </p>
      </div>
    );
  }

  const busy = state.phase !== 'idle';

  return (
    <Button size="sm" variant="outline" onClick={run} disabled={busy}>
      {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
      {state.phase === 'running'
        ? `${state.cursor} of ${state.total} shows checked`
        : state.phase === 'starting'
          ? 'Reading your list…'
          : 'Sync with AniList'}
    </Button>
  );
}
