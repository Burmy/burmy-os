import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PageHeader } from '@/components/ui/page-header';
import { SyncReview } from '@/features/games/sync/sync-review';
import { requireOwner } from '@/server/auth/owner';
import { getSyncRun, listSyncChanges, type SyncRun } from '@/server/db/games/sync';

export const metadata: Metadata = { title: 'Review sync — Burmy' };

/**
 * The sync review screen — shared between Steam and PSN runs, distinguished
 * only by `run.source` (see `SyncReview`'s own doc comment in
 * `sync-review.tsx`). A run belonging to someone else, or a missing run — a
 * bad link, a run from before the database was reset — both render
 * `notFound()` rather than distinguishing the two: same "don't let a
 * crafted id probe for another owner's data" reasoning `docs/SECURITY.md`
 * documents for every other owner-scoped page.
 *
 * Only a `ready` run gets the commit-ready `SyncReview` table — matches
 * `commitSyncRun`'s own gate (`src/server/db/games/sync.ts`). A `running`
 * run still has chunks in flight, and a `failed`/`cancelled`/already-
 * `committed` run has nothing left to review; each renders its own state
 * instead, via `RunStatusNotice` below.
 */
export default async function SyncRunPage({
  params,
}: {
  readonly params: Promise<{ runId: string }>;
}): Promise<React.ReactElement> {
  const { runId } = await params;
  const owner = await requireOwner();

  const run = await getSyncRun(owner.userId, runId);
  if (run === null) notFound();

  return (
    <div>
      <Link href="/games/library" className="text-muted-foreground hover:text-foreground text-sm">
        ← Games
      </Link>
      <PageHeader
        title={`Review ${run.source === 'psn' ? 'PlayStation' : 'Steam'} sync`}
        className="mt-2"
      />

      {/* A real paragraph, not a `PageHeader` prop. This was written as
          `{...(cond ? { subtitle } : {})}`, which compiles and lints and
          renders nothing at all — `PageHeader` has no `subtitle`, and a
          conditional spread bypasses TypeScript's excess-property check. The
          line had never appeared. See `page-header.tsx`'s `subtitle?: never`. */}
      {run.status === 'ready' ? (
        <p className="text-muted-foreground mt-2 text-sm">
          Nothing below has been saved yet — review each change, then apply the ones you want.
        </p>
      ) : null}

      <div className="mt-6">
        {run.status === 'ready' ? (
          <SyncReview run={run} changes={await listSyncChanges(owner.userId, runId)} />
        ) : (
          <RunStatusNotice run={run} />
        )}
      </div>
    </div>
  );
}

function RunStatusNotice({ run }: { readonly run: SyncRun }): React.ReactElement {
  const { message, tone } = describeStatus(run);
  return (
    <div className="bg-card max-w-md space-y-3 rounded-md p-6 text-sm">
      <p className={tone === 'error' ? 'text-destructive font-medium' : 'font-medium'}>{message}</p>
      <Link href="/games/library" className="text-muted-foreground hover:text-foreground underline">
        Back to library
      </Link>
    </div>
  );
}

function describeStatus(run: SyncRun): { readonly message: string; readonly tone: 'info' | 'error' } {
  switch (run.status) {
    case 'running':
      return { message: 'This sync is still in progress — check back in a moment.', tone: 'info' };
    case 'failed':
      return { message: `This sync failed: ${run.errorMessage ?? 'an unexpected error occurred.'}`, tone: 'error' };
    case 'cancelled':
      return { message: 'This sync was cancelled.', tone: 'info' };
    case 'committed':
      return { message: 'This sync has already been committed. Nothing left to review.', tone: 'info' };
    default:
      return { message: 'This sync is not ready to review yet.', tone: 'info' };
  }
}
