import { PageHeaderSkeleton, PageSkeleton, TableSkeleton } from '@/components/ui/page-skeleton';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * A sync run is the one screen the owner reaches while genuinely waiting on a
 * third party (Steam, PSN), so arriving at a blank page here reads as the sync
 * having failed rather than as the page still loading — the worst possible
 * misreading on this particular route.
 */
export default function SyncRunLoading(): React.ReactElement {
  return (
    <PageSkeleton>
      <Skeleton className="h-4 w-20" />
      <PageHeaderSkeleton />
      <TableSkeleton rows={10} />
    </PageSkeleton>
  );
}
