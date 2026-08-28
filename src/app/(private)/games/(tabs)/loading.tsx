import {
  CoverGridSkeleton,
  FilterBarSkeleton,
  PageHeaderSkeleton,
  PageSkeleton,
} from '@/components/ui/page-skeleton';

/**
 * Scoped to the `(tabs)` segment so the Library/Upcoming/Stats bar — rendered
 * by this segment's own `layout.tsx` — stays put while only the content below
 * it swaps. Without this file the nearest boundary was `(private)/loading.tsx`,
 * one level up, which replaced the sub-nav along with the page: switching
 * Games tabs blanked the very tabs being clicked.
 *
 * Shaped as the Library, which is where two of the three tabs land and the
 * one this segment opens on.
 */
export default function GamesTabsLoading(): React.ReactElement {
  return (
    <PageSkeleton>
      <PageHeaderSkeleton />
      <FilterBarSkeleton />
      <CoverGridSkeleton />
    </PageSkeleton>
  );
}
