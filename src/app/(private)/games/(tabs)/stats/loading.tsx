import { ChartPairSkeleton, PageHeaderSkeleton, PageSkeleton, StatCardGridSkeleton } from '@/components/ui/page-skeleton';

/**
 * The Games dashboard's own shape: a stat-card row above paired charts.
 *
 * Added 2026-08-29. Without it this tab fell through to `(tabs)/loading.tsx`,
 * which is a COVER GRID — so every navigation to Stats flashed a wall of
 * placeholder box art before showing numbers. CLAUDE.md's rule is a
 * `loading.tsx` per route SEGMENT, not per subtree, and this is what that rule
 * is guarding against.
 */
export default function GamesStatsLoading(): React.ReactElement {
  return (
    <PageSkeleton>
      <PageHeaderSkeleton />
      <StatCardGridSkeleton />
      <ChartPairSkeleton />
    </PageSkeleton>
  );
}
