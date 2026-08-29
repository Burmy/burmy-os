import { AnimeSyncButton } from '@/features/anime/sync/sync-button';
import { formatRelativeTime } from '@/lib/relative-time';

/**
 * Settings → Anime → Sync — AniList connection state, last-synced time, and
 * the sync trigger itself, in the shape Settings → Games → Sync already
 * established (one `divide-y` list, one row per source, the button on the
 * right). Pure and presentational: the Settings page fetches everything via
 * `isAnilistConfiguredAction` and `getAnimeLastSyncedAtAction`.
 *
 * ONE ROW, NOT TWO. Games has Steam and PlayStation; anime has one source and
 * will keep having one — the streaming site the owner watches on writes to
 * AniList, and AniList is what Burmy reads. A second row would be inventing a
 * source that does not exist.
 *
 * "Not connected" names the exact variable, because a disabled control with
 * no reason attached is the failure mode the Steam button's own comment
 * documents. AniList needs no token, no OAuth and no secret — the owner's
 * profile is public and a username is the whole configuration — so, unlike
 * the PSN row, there is nothing here that expires and nothing to re-paste.
 */
export function AnimeSyncSection({
  configured,
  lastSyncedAt,
}: {
  readonly configured: boolean;
  readonly lastSyncedAt: Date | null;
}): React.ReactElement {
  return (
    <ul className="mt-3 divide-y">
      <li className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
        <div>
          <span className="font-medium">AniList</span>
          {configured ? (
            <p className="text-muted-foreground text-xs">
              Connected
              {lastSyncedAt ? ` · Synced ${formatRelativeTime(lastSyncedAt)}` : ' — not yet synced'}
            </p>
          ) : (
            <p className="text-muted-foreground text-xs">
              Not connected — set <code className="font-mono">ANILIST_USERNAME</code> to your AniList username to
              enable sync. The profile must be public; no token or sign-in is involved.
            </p>
          )}
        </div>
        <AnimeSyncButton configured={configured} />
      </li>
    </ul>
  );
}
