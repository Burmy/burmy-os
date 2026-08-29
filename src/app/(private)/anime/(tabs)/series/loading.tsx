import { FilterBarSkeleton, PageHeaderSkeleton, PageSkeleton } from '@/components/ui/page-skeleton';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Wide franchise cards, two or three to a row — not the Library's portrait
 * cover wall, which is what the `(tabs)` fallback would otherwise render here.
 */
export default function AnimeSeriesListLoading(): React.ReactElement {
  return (
    <PageSkeleton>
      <PageHeaderSkeleton />
      <FilterBarSkeleton />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    </PageSkeleton>
  );
}
