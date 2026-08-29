import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PageHeader } from '@/components/ui/page-header';
import { AnimeSyncReview } from '@/features/anime/sync/sync-review';
import { isUuid } from '@/lib/uuid';
import { requireOwner } from '@/server/auth/owner';
import { type AnimeSyncRun, getAnimeSyncRun, listAnimeSyncChanges } from '@/server/db/anime/sync';

export const metadata: Metadata = { title: 'Review AniList sync — Burmy' };

/**
 * The AniList sync review screen.
 *
 * A run belonging to someone else and a run that does not exist both render
 * `notFound()` without distinguishing the two — the same "a crafted id must
 * never probe for another owner's data" rule `docs/SECURITY.md` states for
 * every owner-scoped page. The `isUuid` guard runs first so a non-UUID path
 * segment never reaches Postgres as a malformed `uuid` literal, which would
 * surface as a 500 rather than a 404.
 *
 * Only a `ready` run gets the review table, matching `commitAnimeSyncRun`'s
 * own gate. A `running` run still has chunks in flight; a
 * `failed`/`cancelled`/already-`committed` run has nothing left to approve.
 */
export default async function AnimeSyncRunPage({
  params,
}: {
  readonly params: Promise<{ runId: string }>;
}): Promise<React.ReactElement> {
  const { runId } = await params;
  if (!isUuid(runId)) notFound();

  const owner = await requireOwner();
  const run = await getAnimeSyncRun(owner.userId, runId);
  if (run === null) notFound();

  return (
    <div className="min-w-0">
      <Link href="/anime/library" className="text-muted-foreground hover:text-foreground text-sm">
        ← Anime
      </Link>
      <PageHeader
        title="Review AniList sync"
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

      <div className="mt-6 min-w-0">
        {run.status === 'ready' ? (
          <AnimeSyncReview run={run} changes={await listAnimeSyncChanges(owner.userId, runId)} />
        ) : (
          <RunStatusNotice run={run} />
        )}
      </div>
    </div>
  );
}

function RunStatusNotice({ run }: { readonly run: AnimeSyncRun }): React.ReactElement {
  const { message, tone } = describeStatus(run);
  return (
    <div className="bg-card max-w-md space-y-3 rounded-md p-6 text-sm">
      <p className={tone === 'error' ? 'text-destructive font-medium' : 'font-medium'}>{message}</p>
      <Link href="/anime/library" className="text-muted-foreground hover:text-foreground underline">
        Back to library
      </Link>
    </div>
  );
}

function describeStatus(run: AnimeSyncRun): { readonly message: string; readonly tone: 'info' | 'error' } {
  switch (run.status) {
    case 'running':
      return { message: 'This sync is still in progress — check back in a moment.', tone: 'info' };
    case 'failed':
      return { message: `This sync failed: ${run.errorMessage ?? 'an unexpected error occurred.'}`, tone: 'error' };
    case 'cancelled':
      return { message: 'This sync was cancelled.', tone: 'info' };
    case 'committed':
      return { message: 'This sync has already been applied. Nothing left to review.', tone: 'info' };
    default:
      return { message: 'This sync is not ready to review yet.', tone: 'info' };
  }
}
