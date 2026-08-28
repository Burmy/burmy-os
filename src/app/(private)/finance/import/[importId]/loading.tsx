import { PageHeaderSkeleton, PageSkeleton, TableSkeleton } from '@/components/ui/page-skeleton';

/**
 * The import review table — the longest single wait in Finance, since the page
 * renders every staged row of a real statement. It is also reached immediately
 * after an upload, when the owner is already wondering whether the file
 * worked, so silence here is the most expensive silence in the app.
 */
export default function ImportReviewLoading(): React.ReactElement {
  return (
    <PageSkeleton>
      <PageHeaderSkeleton />
      <TableSkeleton rows={12} />
    </PageSkeleton>
  );
}
