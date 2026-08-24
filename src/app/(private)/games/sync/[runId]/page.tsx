import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { SyncReview } from '@/features/games/sync/sync-review';
import { requireOwner } from '@/server/auth/owner';
import { getSyncRun, listSyncChanges } from '@/server/db/games/sync';

export const metadata: Metadata = { title: 'Review Steam sync — Burmy' };

/**
 * The Steam sync review screen. A run belonging to someone else, or a
 * missing run — a bad link, a run from before the database was reset — both
 * render `notFound()` rather than distinguishing the two: same "don't let a
 * crafted id probe for another owner's data" reasoning `docs/SECURITY.md`
 * documents for every other owner-scoped page.
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

  const changes = await listSyncChanges(owner.userId, runId);

  return (
    <div>
      <Link href="/games/library" className="text-muted-foreground hover:text-foreground text-sm">
        ← Games
      </Link>
      <h1 className="mt-2 text-xl font-semibold">Review Steam sync</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Nothing below has been saved yet — review each change, then apply the ones you want.
      </p>

      <div className="mt-6">
        <SyncReview run={run} changes={changes} />
      </div>
    </div>
  );
}
