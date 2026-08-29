import { EmptyState } from '@/components/finance/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import type { WatchLogBounds, WatchLogEntry } from '@/server/db/anime/watch-log';
import { WatchLogList } from './watch-log-list';

/**
 * The Log tab: every episode AniList recorded, newest first.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE WATERMARK IS NOT DECORATION.
 *
 * AniList's activity feed has an unknown retention, and Burmy can only import
 * what the feed still carries. A log that starts in 2024 for someone who has
 * watched anime since 2015 looks exactly like broken data unless the screen
 * says otherwise — so it says otherwise, naming the oldest entry it holds.
 * Stating a limitation costs one line; letting it read as a bug costs trust in
 * every other number on the page.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Read-only, deliberately. The log is a record of what happened; editing it
 * would make it a record of what the owner most recently said happened, which
 * is what `progress` on the show itself already is.
 */
export function AnimeLogView({
  entries,
  bounds,
  limit,
}: {
  readonly entries: readonly WatchLogEntry[];
  readonly bounds: WatchLogBounds;
  /** The page size, so a truncated view can say so rather than looking like the whole log. */
  readonly limit: number;
}): React.ReactElement {
  return (
    <div className="min-w-0 space-y-8">
      <PageHeader
        title="Log"
        meta={
          bounds.total === 0 ? null : (
            <>
              <span>{bounds.total.toLocaleString()} entries</span>
              {bounds.oldest === null ? null : (
                <span>· back to {bounds.oldest.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</span>
              )}
            </>
          )
        }
      />

      {bounds.total === 0 ? (
        <EmptyState>
          Nothing logged yet. Your watch history comes from AniList&apos;s activity feed and imports when a
          sync is applied — run one from Settings.
        </EmptyState>
      ) : (
        <>
          <WatchLogList entries={entries} />

          {bounds.total > limit ? (
            <p className="text-muted-foreground text-sm">
              Showing the {limit.toLocaleString()} most recent of {bounds.total.toLocaleString()} entries.
            </p>
          ) : null}

          {bounds.oldest === null ? null : (
            <p className="text-muted-foreground text-sm">
              This log begins on{' '}
              {bounds.oldest.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })} —
              AniList&apos;s activity feed does not reach back further, so anything watched before that is not
              recorded here.
            </p>
          )}
        </>
      )}
    </div>
  );
}
