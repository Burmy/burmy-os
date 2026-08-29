import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The series page's shape: a cover column, a stat row, and the member list.
 * Present for the prefetch as much as the skeleton — Next 16 does not prefetch
 * a dynamic route without a `loading.tsx`, and every route here is dynamic.
 */
export default function AnimeSeriesLoading(): React.ReactElement {
  return (
    <PageSkeleton>
      <Skeleton className="h-4 w-20" />
      <div className="grid gap-8 sm:grid-cols-[200px_1fr]">
        <Skeleton className="aspect-2/3 w-full" />
        <div className="space-y-6">
          <Skeleton className="h-9 w-2/3" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
          <div className="space-y-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        </div>
      </div>
    </PageSkeleton>
  );
}
