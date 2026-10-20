import {
  ChartPairSkeleton,
  PageHeaderSkeleton,
  PageSkeleton,
  SectionSkeleton,
  StatCardGridSkeleton,
} from '@/components/ui/page-skeleton';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The Games dashboard's own shape, top to bottom: two rows of stat cards, the
 * Year-by-year table, the three trend charts, the breakdown, two rows of
 * leaderboards and the four callouts — at roughly the real heights, so the
 * page fills in without anything shifting (owner, 2026-10-19).
 *
 * Added 2026-08-29 as cards-plus-charts. Without it this tab fell through to
 * `(tabs)/loading.tsx`, which is a COVER GRID — so every navigation to Stats
 * flashed a wall of placeholder box art before showing numbers. CLAUDE.md's
 * rule is a `loading.tsx` per route SEGMENT, not per subtree, and this is
 * what that rule is guarding against.
 */
export default function GamesStatsLoading(): React.ReactElement {
  return (
    <PageSkeleton>
      <PageHeaderSkeleton withAction={false} />
      <StatCardGridSkeleton count={8} />
      <SectionSkeleton height="h-96" />
      <div className="space-y-3">
        <Skeleton className="h-5 w-24" />
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      </div>
      <SectionSkeleton height="h-80" />
      <ChartPairSkeleton />
      <ChartPairSkeleton />
      <StatCardGridSkeleton count={4} />
    </PageSkeleton>
  );
}
