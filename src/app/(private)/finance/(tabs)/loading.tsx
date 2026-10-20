import {
  ChartPairSkeleton,
  FilterBarSkeleton,
  PageHeaderSkeleton,
  PageSkeleton,
  SectionSkeleton,
  StatCardGridSkeleton,
} from '@/components/ui/page-skeleton';

/**
 * Scoped to the `(tabs)` segment, not the whole app: the Monthly/Transactions/
 * Review bar (this segment's own `layout.tsx`) stays instant and static on
 * every tab click — only the content area below it swaps.
 *
 * Shaped as the Monthly dashboard, top to bottom: header, filter row, eight
 * stat cards, two chart pairs, the eight Insights cards and the largest-expenses
 * list (owner, 2026-10-19: "update the skeleton accordingly everywhere").
 * That is the tab this segment opens on and the heaviest of the three,
 * so it is the shape worth matching. Transactions and Review are both a header
 * plus a filter row plus a table, which this leads with identically — the stat
 * cards resolving into a table is a smaller shift than a bare grey block
 * resolving into anything.
 */
export default function FinanceTabsLoading(): React.ReactElement {
  return (
    <PageSkeleton>
      <PageHeaderSkeleton />
      <FilterBarSkeleton />
      <StatCardGridSkeleton count={8} />
      <ChartPairSkeleton />
      <ChartPairSkeleton />
      <StatCardGridSkeleton count={8} />
      <SectionSkeleton height="h-64" />
    </PageSkeleton>
  );
}
