import { PsnSyncButton, SonyTokenLink } from '@/features/games/sync/psn-sync-button';
import { SyncButton } from '@/features/games/sync/sync-button';
import { formatRelativeTime } from '@/lib/relative-time';
import type { PsnTokenAge } from '@/server/games/psn-token-age';

/**
 * Settings → Games → Sync — the standing home for Steam/PlayStation
 * connection state, last-synced times, PSN token age, AND the actual sync
 * trigger buttons. The buttons used to live on the Library screen's top bar;
 * they moved here entirely (no lightweight link left behind on Library) so
 * that connecting/syncing a source and reading its status live in one place.
 * `SyncButton`/`PsnSyncButton` are self-contained Client Components needing
 * only a `configured: boolean` prop, so relocating them was a pure move, not
 * a rewrite. This component is otherwise still pure/presentational: all the
 * data is fetched by the Settings page itself via
 * `isSteamConfiguredAction`/`isPsnConfiguredAction` (`sync-actions.ts`/
 * `psn-actions.ts`), `getLastSyncedTimesAction`, and `getPsnTokenAgeAction`
 * — reused rather than reimplemented.
 *
 * Reuses `SonyTokenLink` from `psn-sync-button.tsx` for the one clickable
 * `ca.account.sony.com` link, rather than a second copy of the URL.
 */
export function GamesSyncSection({
  steamConfigured,
  steamLastSyncedAt,
  psnConfigured,
  psnLastSyncedAt,
  psnTokenAge,
}: {
  readonly steamConfigured: boolean;
  readonly steamLastSyncedAt: Date | null;
  readonly psnConfigured: boolean;
  readonly psnLastSyncedAt: Date | null;
  readonly psnTokenAge: PsnTokenAge;
}): React.ReactElement {
  return (
    <ul className="mt-3 divide-y">
      <li className="flex items-center justify-between gap-3 py-2 text-sm">
        <div>
          <span className="font-medium">Steam</span>
          {steamConfigured ? (
            <p className="text-muted-foreground text-xs">
              Connected
              {steamLastSyncedAt ? ` · Synced ${formatRelativeTime(steamLastSyncedAt)}` : ' — not yet synced'}
            </p>
          ) : (
            <p className="text-muted-foreground text-xs">
              Not connected — set <code className="font-mono">STEAM_API_KEY</code> and{' '}
              <code className="font-mono">STEAM_ID</code> to enable sync.
            </p>
          )}
        </div>
        <SyncButton configured={steamConfigured} />
      </li>

      <li className="flex items-center justify-between gap-3 py-2 text-sm">
        <div>
          <span className="font-medium">PlayStation</span>
          {psnConfigured ? (
            <>
              <p className="text-muted-foreground text-xs">
                Connected
                {psnLastSyncedAt ? ` · Synced ${formatRelativeTime(psnLastSyncedAt)}` : ' — not yet synced'}
              </p>
              <PsnTokenAgeLine tokenAge={psnTokenAge} />
            </>
          ) : (
            <p className="text-muted-foreground text-xs">
              Not connected — set <code className="font-mono">PSN_NPSSO</code> to enable sync. Get one from{' '}
              <SonyTokenLink /> while logged in to PlayStation in this browser.
            </p>
          )}
        </div>
        <PsnSyncButton configured={psnConfigured} />
      </li>
    </ul>
  );
}

/**
 * The current token's age, with the same warning threshold `PsnSyncButton`
 * used to render inline (`psnTokenAge`'s own doc comment in
 * `psn-token-age.ts`) — `'unknown'` stated plainly rather than left blank,
 * since a blank field would read as "fresh," which is not a known fact.
 */
function PsnTokenAgeLine({ tokenAge }: { readonly tokenAge: PsnTokenAge }): React.ReactElement {
  if (tokenAge.status === 'unknown') {
    return <p className="text-muted-foreground text-xs">Token age unknown — no successful sync with it yet.</p>;
  }

  if (tokenAge.status === 'warning') {
    return (
      <p className="text-xs text-amber-600 dark:text-amber-500">
        Token {tokenAge.ageDays}d old — may expire soon. Get a new one from <SonyTokenLink /> while logged in to
        PlayStation in this browser.
      </p>
    );
  }

  // The link is here too, not only in the `warning` and not-connected states.
  // A healthy token still expires eventually, and when it does the owner is
  // mid-task and wants one click, not a hunt for where the page mentioned
  // Sony last. Same `SonyTokenLink` every other branch uses — one URL.
  return (
    <p className="text-muted-foreground text-xs">
      Token {tokenAge.ageDays}d old — refresh it at <SonyTokenLink /> any time.
    </p>
  );
}
