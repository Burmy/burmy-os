/**
 * Route-level loading state.
 *
 * Deliberately a plain skeleton with no spinner: the pages under here are
 * server-rendered database reads that take milliseconds locally, and a spinner
 * that flashes for 40ms reads as jank. This exists so a slow query shows
 * structure rather than a blank panel.
 */
export default function PrivateLoading(): React.ReactElement {
  return (
    <div aria-busy="true" aria-live="polite" className="space-y-4">
      <span className="sr-only">Loading</span>
      <div className="bg-muted h-7 w-48 animate-pulse rounded" />
      <div className="bg-muted h-4 w-72 animate-pulse rounded" />
      <div className="bg-muted/60 mt-8 h-40 w-full animate-pulse rounded" />
    </div>
  );
}
