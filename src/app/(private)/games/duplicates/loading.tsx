import { PageHeaderSkeleton, PageSkeleton } from '@/components/ui/page-skeleton';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Present for BOTH reasons a `loading.tsx` exists in this app: it gives the
 * route a fallback, and — per Next 16's own prefetching guide — a dynamic
 * route without one is not prefetched at all. Every route here is dynamic, so
 * the missing-prefetch half of that cost is the invisible one.
 *
 * Shaped as two side-by-side cards with a divider, because that is what a
 * duplicate pair looks like; a generic table fallback would resolve into
 * something structurally unrelated.
 */
export default function DuplicatesLoading(): React.ReactElement {
  return (
    <PageSkeleton>
      <Skeleton className="h-4 w-20" />
      <PageHeaderSkeleton withAction={false} />

      {Array.from({ length: 2 }, (_, card) => (
        <div key={card} className="space-y-4 rounded-md border p-5">
          <Skeleton className="h-4 w-2/3" />
          <div className="grid gap-4 md:grid-cols-[1fr_auto_1fr]">
            <Skeleton className="h-40 w-full" />
            <Skeleton className="hidden h-40 w-5 md:block" />
            <Skeleton className="h-40 w-full" />
          </div>
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-9 w-28 self-end" />
        </div>
      ))}
    </PageSkeleton>
  );
}
