import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The game page's own shape: a sticky cover column on the left, inline-editable
 * detail rows on the right. Built from `Skeleton` directly rather than the
 * shared compositions — a 3:4 cover beside a two-column field list is not a
 * shape any other route has, and bending `PageHeaderSkeleton` to fit would
 * produce a fallback that matches neither.
 */
export default function GameDetailLoading(): React.ReactElement {
  return (
    <PageSkeleton>
      <Skeleton className="h-4 w-20" />
      <div className="grid gap-8 sm:grid-cols-[280px_1fr]">
        <div className="space-y-4">
          <Skeleton className="aspect-3/4 w-full" />
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
        <div className="space-y-6">
          <Skeleton className="h-9 w-2/3" />
          <div className="grid gap-x-8 gap-y-2 lg:grid-cols-2">
            {Array.from({ length: 10 }, (_, i) => (
              <Skeleton key={i} className="h-7 w-full" />
            ))}
          </div>
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    </PageSkeleton>
  );
}
