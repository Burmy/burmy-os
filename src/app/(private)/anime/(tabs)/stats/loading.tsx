import { ChartPairSkeleton, PageHeaderSkeleton, PageSkeleton, StatCardGridSkeleton } from '@/components/ui/page-skeleton';

/**
 * The stats page's own shape: a four-card row above paired charts.
 *
 * Its own file rather than relying on the `(tabs)` fallback, which would
 * replace the tab bar along with the content and blank the very tabs being
 * clicked — the documented reason each route SEGMENT gets one.
 */
export default function AnimeStatsLoading(): React.ReactElement {
  return (
    <PageSkeleton>
      <PageHeaderSkeleton />
      <StatCardGridSkeleton count={4} />
      <ChartPairSkeleton />
    </PageSkeleton>
  );
}
