import { CoverGridSkeleton, FilterBarSkeleton, PageHeaderSkeleton, PageSkeleton } from '@/components/ui/page-skeleton';

/**
 * The Library tab's fallback, and the group's floor.
 *
 * Its own file rather than one shared with the tab bar's parent: a boundary one
 * level up replaces the sub-nav along with the content, so switching tabs
 * blanks the very tabs being clicked. It also earns its keep invisibly — Next
 * 16 does not prefetch a dynamic route without one, and every route here is
 * dynamic.
 *
 * Shaped as a cover grid, which is Library and nothing else, so `log/` and
 * `stats/` each carry their own — the nearest fallback wins, and a day-grouped
 * list and a stat row look nothing like a wall of covers. Library needs no
 * fourth file: this one already is its shape.
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
