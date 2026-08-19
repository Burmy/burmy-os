/**
 * Scoped to the `(tabs)` segment, not the whole app: the SubNav bar (rendered
 * by this segment's own `layout.tsx`) stays instant and static on every
 * Monthly/Transactions/Review click — only this fallback swaps in for the
 * page content area while the next tab's data streams in. Same plain,
 * no-spinner skeleton convention as `(private)/loading.tsx`.
 */
export default function FinanceTabsLoading(): React.ReactElement {
  return (
    <div aria-busy="true" aria-live="polite" className="space-y-4">
      <span className="sr-only">Loading</span>
      <div className="bg-muted h-7 w-48 animate-pulse rounded" />
      <div className="bg-muted mt-8 h-40 w-full animate-pulse rounded" />
    </div>
  );
}
