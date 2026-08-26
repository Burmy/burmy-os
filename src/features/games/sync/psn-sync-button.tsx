'use client';

import { Loader2, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import type { PsnTokenAge } from '@/server/games/psn-token-age';
import { advancePsnSyncAction, startPsnSyncAction } from './psn-actions';
import { formatRelativeTime } from './relative-time';
import { advanceSyncEnrichmentAction } from './sync-actions';

/**
 * Sony's NPSSO retrieval endpoint. Only ever useful while already logged in
 * to PlayStation IN THIS BROWSER (it reads that session's cookie) — every
 * caller below pairs the link with that one-line caveat rather than leaving
 * the owner to click through and wonder why it didn't work.
 */
const PSN_TOKEN_URL = 'https://ca.account.sony.com/api/v1/ssocookie';

type SyncState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'starting' }
  | { readonly phase: 'running'; readonly cursor: number; readonly total: number }
  | { readonly phase: 'enriching' }
  | { readonly phase: 'token_expired' };

/** Opens in a new tab so the owner never loses this page mid-retrieval. */
function SonyTokenLink(): React.ReactElement {
  return (
    <a href={PSN_TOKEN_URL} target="_blank" rel="noreferrer" className="underline">
      ca.account.sony.com
    </a>
  );
}

/**
 * The small status line under an enabled, non-expired button — "Synced …"
 * and the token-age note, joined into ONE quiet line rather than two (see
 * `PsnSyncButton`'s own doc comment on keeping this chrome minimal).
 *
 * `lastSyncedAt` is omitted (never printed as "never synced") when PSN has
 * no successful run at all — same honesty rule `SyncButton` follows for
 * Steam. The token-age half always renders SOMETHING, including "token age
 * unknown" when the current token has never itself completed a successful
 * sync: `psnTokenAge`'s own doc comment explains why that is stated
 * plainly rather than left blank — a blank field would read as "fresh,"
 * which is not a known fact.
 */
function PsnStatusLine({
  lastSyncedAt,
  tokenAge,
}: {
  readonly lastSyncedAt: Date | null;
  readonly tokenAge: PsnTokenAge;
}): React.ReactElement {
  const tokenText =
    tokenAge.status === 'unknown'
      ? 'token age unknown'
      : tokenAge.status === 'warning'
        ? `token ${tokenAge.ageDays}d old — may expire soon`
        : `token ${tokenAge.ageDays}d old`;

  return (
    <p className={tokenAge.status === 'warning' ? 'text-xs text-amber-600 dark:text-amber-500' : 'text-muted-foreground text-xs'}>
      {lastSyncedAt ? `Synced ${formatRelativeTime(lastSyncedAt)} · ` : ''}
      {tokenText}
    </p>
  );
}

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
 * Sony. A configured-but-expired token is discovered only at click time, as
 * a `startPsnSyncAction` failure: `psn-client.ts`'s three-way
 * `'not_configured' | 'token_expired' | 'unavailable'` contract comes back
 * as three differently-worded messages (see `psn-actions.ts`), always shown
 * through the same `toast.error` path `SyncButton` uses for Steam's
 * failures — never collapsed into one generic "sync failed" blob, and never
 * thrown. `'token_expired'` ADDITIONALLY switches this button into a
 * persistent `token_expired` phase (below) rather than staying in `idle`:
 * the toast alone cannot carry a real, clickable link to Sony's retrieval
 * page (it is plain text and dismisses itself after a few seconds), and
 * this is the one failure the owner needs a durable pointer to act on.
 */
export function PsnSyncButton({
  configured,
  lastSyncedAt = null,
  tokenAge = { status: 'unknown', ageDays: null },
}: {
  readonly configured: boolean;
  /** The most recent time a PSN sync run reached `ready`/`committed`, or `null` if PSN has never successfully synced. */
  readonly lastSyncedAt?: Date | null;
  /** How long the CURRENT `PSN_NPSSO` has been in use, from `getPsnTokenAgeAction` — see `psn-token-age.ts`. */
  readonly tokenAge?: PsnTokenAge;
}): React.ReactElement {
  const router = useRouter();
  const [state, setState] = useState<SyncState>({ phase: 'idle' });

  async function run(): Promise<void> {
    setState({ phase: 'starting' });

    const start = await startPsnSyncAction();
    if (!start.ok) {
      toast.error(start.error);
      setState(start.reason === 'token_expired' ? { phase: 'token_expired' } : { phase: 'idle' });
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

    // Enrichment is a nicety, never a gate — see `SyncButton`'s matching
    // comment and `advanceSyncEnrichmentAction`'s own doc comment in
    // `sync-actions.ts` for why an error here just ends the loop rather
    // than blocking the owner from reaching the review screen.
    setState({ phase: 'enriching' });
    for (;;) {
      const enrichment = await advanceSyncEnrichmentAction(runId);
      if ('error' in enrichment || enrichment.done) break;
    }

    router.push(`/games/sync/${runId}`);
  }

  if (!configured) {
    return (
      // The explanation stays VISIBLE, not tooltip-only. A silently disabled
      // button leaves the owner with no idea why PlayStation sync does
      // nothing, and a `title` is hover-only — invisible on touch entirely.
      <div className="flex flex-col items-end gap-1">
        <Button size="sm" variant="outline" disabled title="Set PSN_NPSSO to enable PlayStation sync.">
          <RefreshCw className="size-4" aria-hidden />
          Sync with PlayStation
        </Button>
        <p className="text-muted-foreground text-xs">
          Needs <code className="font-mono">PSN_NPSSO</code> — get one from <SonyTokenLink /> while logged in to
          PlayStation in this browser
        </p>
      </div>
    );
  }

  if (state.phase === 'token_expired') {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button size="sm" variant="outline" disabled title="Your PSN_NPSSO token expired — paste a new one.">
          <RefreshCw className="size-4" aria-hidden />
          Sync with PlayStation
        </Button>
        <p className="text-muted-foreground text-xs">
          Token expired — get a new one from <SonyTokenLink /> while logged in to PlayStation in this browser
        </p>
      </div>
    );
  }

  const busy = state.phase !== 'idle';

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="outline" onClick={run} disabled={busy}>
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
        {state.phase === 'running'
          ? `${state.cursor} of ${state.total} games checked`
          : state.phase === 'enriching'
            ? 'Adding cover art…'
            : state.phase === 'starting'
              ? 'Starting…'
              : 'Sync with PlayStation'}
      </Button>
      <PsnStatusLine lastSyncedAt={lastSyncedAt} tokenAge={tokenAge} />
    </div>
  );
}
