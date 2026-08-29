import { PageHeaderSkeleton, PageSkeleton } from '@/components/ui/page-skeleton';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Day headings above grouped rows — the log's own shape, not a table's.
 *
 * Its own file rather than the `(tabs)` fallback, which would replace the tab
 * bar along with the content and blank the very tabs being clicked.
 */
export default function AnimeLogLoading(): React.ReactElement {
  return (
    <PageSkeleton>
      <PageHeaderSkeleton />
      {Array.from({ length: 4 }, (_, group) => (
        <div key={group} className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-28 w-full" />
        </div>
      ))}
    </PageSkeleton>
  );
}
