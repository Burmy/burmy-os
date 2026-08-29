import { CoverGridSkeleton, FilterBarSkeleton, PageHeaderSkeleton, PageSkeleton } from '@/components/ui/page-skeleton';

/**
 * Its own fallback rather than one shared with the tab bar's parent: a boundary
 * one level up replaces the sub-nav along with the content, so switching tabs
 * blanks the very tabs being clicked. It also earns its keep invisibly — Next
 * 16 does not prefetch a dynamic route without one, and every route here is
 * dynamic.
 */
export default function AnimeTabsLoading(): React.ReactElement {
  return (
    <PageSkeleton>
      <PageHeaderSkeleton withAction={false} />
      <FilterBarSkeleton />
      <CoverGridSkeleton />
    </PageSkeleton>
  );
}
