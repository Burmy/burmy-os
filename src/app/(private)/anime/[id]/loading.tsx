import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The show page's own shape: a sticky 2:3 cover column on the left, inline
 * detail rows on the right. Built from `Skeleton` directly rather than the
 * shared compositions, for the reason `games/[id]/loading.tsx` gives — this
 * layout is not one any other route has, and bending `PageHeaderSkeleton` to
 * fit would produce a fallback matching neither.
 *
 * It also buys the PREFETCH. Next 16 skips prefetching a dynamic route with no
 * `loading.tsx` at all, and every route in this app is dynamic — so a missing
 * file here would cost the skeleton and, invisibly, the warm navigation too.
 */
export default function AnimeDetailLoading(): React.ReactElement {
  return (
    <PageSkeleton>
      <Skeleton className="h-4 w-20" />
      <div className="grid gap-8 sm:grid-cols-[260px_1fr]">
        <div className="space-y-4">
          <Skeleton className="aspect-2/3 w-full" />
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
