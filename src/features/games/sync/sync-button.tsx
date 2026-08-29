'use client';

import { Loader2, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { advanceSteamSyncAction, advanceSyncEnrichmentAction, startSteamSyncAction } from './sync-actions';

type SyncState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'starting' }
  | { readonly phase: 'running'; readonly cursor: number; readonly total: number }
  | { readonly phase: 'enriching' };

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
 * A clean, SINGLE-LINE control — no "Synced …" caption underneath. That
 * status now lives in Settings → Games → Sync (`games-sync-section.tsx`,
 * fed by the same `getLastSyncedTimesAction`), which is where the Library
 * header's `flex items-center` row of "Add game"/the view toggle/this
 * button needs it to stay: every other control there is one line tall, and
 * a variable-height caption made this one taller and vertically offset from
 * the rest.
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

    // Enrichment is a nicety, never a gate: if it errors (run somehow no
    // longer 'ready') this loop just stops and the owner still reaches the
    // review screen, same as before enrichment existed — see
    // `advanceSyncEnrichmentAction`'s own "NEVER BLOCKS OR FAILS A SYNC" doc
    // comment in `sync-actions.ts`.
    setState({ phase: 'enriching' });
    for (;;) {
      const enrichment = await advanceSyncEnrichmentAction(runId);
      if ('error' in enrichment || enrichment.done) break;
    }

    router.push(`/games/sync/${runId}`);
  }

  if (!configured) {
    return (
      // The button plus a short, still-VISIBLE (never tooltip-only) hint
      // naming both required vars, so a silently disabled button never leaves
      // the owner guessing why sync does nothing. Full context — connection
      // state, last synced — lives in Settings; this stays just enough to be
      // self-explanatory in place.
      //
      // `flex-wrap`: one line wherever it fits, two on a phone. Without it
      // this pair alone pushed Settings to 528px on a 390px viewport —
      // measured, and it had been that way since the button moved here.
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled title="Set STEAM_API_KEY and STEAM_ID to enable Steam sync.">
          <RefreshCw className="size-4" aria-hidden />
          Sync with Steam
        </Button>
        {/* BOTH vars are named. Steam needs the pair, and naming only one
            would leave the owner setting it and wondering why sync still
            does nothing. */}
        <p className="text-muted-foreground text-xs">
          Needs <code className="font-mono">STEAM_API_KEY</code> + <code className="font-mono">STEAM_ID</code>
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
        : state.phase === 'enriching'
          ? 'Adding cover art…'
          : state.phase === 'starting'
            ? 'Starting…'
            : 'Sync with Steam'}
    </Button>
  );
}
