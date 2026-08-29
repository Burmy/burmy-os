import { FilterBarSkeleton, PageHeaderSkeleton, PageSkeleton } from '@/components/ui/page-skeleton';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Upcoming is a grouped list of dated rows, not a cover wall.
 *
 * Added 2026-08-29 for the same reason as `stats/loading.tsx` beside it: this
 * tab fell through to `(tabs)/loading.tsx`, whose cover grid is the Library's
 * shape and nobody else's.
 */
export default function GamesUpcomingLoading(): React.ReactElement {
  return (
    <PageSkeleton>
      <PageHeaderSkeleton />
      <FilterBarSkeleton />
      {Array.from({ length: 3 }, (_, group) => (
        <div key={group} className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-32 w-full" />
        </div>
      ))}
    </PageSkeleton>
  );
}
