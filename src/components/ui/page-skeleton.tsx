import { Skeleton } from './skeleton';

/**
 * Route-shaped loading fallbacks.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THESE ARE SHAPED LIKE THE PAGE, AND WHY THAT IS THE WHOLE POINT
 *
 * Every route in this app is dynamic (`ƒ` in the build output), and Next.js
 * only prefetches a dynamic route as far as its nearest `loading` boundary —
 * so a segment without one is BOTH un-prefetched and silent on click. Before
 * this, only two segments had one, and the fallback they rendered was a
 * generic title-bar-and-grey-block that looked like no page in the app. Every
 * navigation therefore flashed to something unrelated and then flashed again
 * to the real content: two layout shifts where there should be none.
 *
 * A fallback that matches the page it is standing in for reads as the page
 * arriving rather than as a different screen interrupting. That is the
 * difference between "loading" and "instant" at identical network speed, and
 * it is the cheapest perceived-performance win available here.
 *
 * These are composition helpers, not a framework: each `loading.tsx` picks the
 * pieces its own route actually renders. Where a route's shape is genuinely
 * unique (the game detail page's cover-plus-details split) it builds its own
 * out of `Skeleton` directly instead of bending one of these to fit.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Wraps a fallback so screen readers announce it once and assistive tech knows
 * the region is busy. Every `loading.tsx` in the app goes through this rather
 * than repeating the ARIA — a fallback that is invisible to a screen reader is
 * a silent navigation for exactly the users least able to guess what happened.
 */
export function PageSkeleton({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  return (
    <div aria-busy="true" aria-live="polite" className="space-y-8">
      <span className="sr-only">Loading</span>
      {children}
    </div>
  );
}

/** Title on the left, action button on the right — matches `PageHeader`. */
export function PageHeaderSkeleton({ withAction = true }: { readonly withAction?: boolean }): React.ReactElement {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-28" />
      </div>
      {withAction ? <Skeleton className="h-9 w-36" /> : null}
    </div>
  );
}

/** The filter row: a few controls left, a display toggle right. */
export function FilterBarSkeleton(): React.ReactElement {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-9 w-24" />
        <Skeleton className="h-9 w-24" />
      </div>
      <Skeleton className="h-9 w-40" />
    </div>
  );
}

/**
 * Matches `StatCardGrid`'s own responsive column counts so nothing reflows
 * when the real cards arrive.
 *
 * That sentence was here before and was NOT TRUE: this rendered
 * `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4` while
 * `StatCardGrid` renders `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4`, so every
 * skeleton→content swap re-laid the whole row out — one column becoming two on
 * mobile, three becoming four at `lg`. The class list below is now copied from
 * `stat-card-grid.tsx` exactly; if that one changes, this one has to change
 * with it, which is the cost of a fallback that is a separate element.
 */
export function StatCardGridSkeleton({ count = 6 }: { readonly count?: number }): React.ReactElement {
  return (
    <div className="grid auto-rows-fr grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-32 w-full" />
      ))}
    </div>
  );
}

/** Two charts side by side from `xl`, stacked below it. */
export function ChartPairSkeleton(): React.ReactElement {
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
      <Skeleton className="h-72 w-full" />
      <Skeleton className="h-72 w-full" />
    </div>
  );
}

/**
 * A header row plus `rows` body rows.
 *
 * Rows are deliberately uniform-width rather than randomised: a "realistic"
 * ragged skeleton draws the eye to the variation instead of to the fact that
 * content is coming, and randomness would also make the fallback differ
 * between server and client renders.
 */
export function TableSkeleton({ rows = 8 }: { readonly rows?: number }): React.ReactElement {
  return (
    <div className="space-y-2">
      <Skeleton className="h-9 w-full" />
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-11 w-full opacity-60" />
      ))}
    </div>
  );
}

/** The Games gallery: portrait cover tiles on the same grid `GameGrid` uses. */
export function CoverGridSkeleton({ count = 12 }: { readonly count?: number }): React.ReactElement {
  return (
    <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="aspect-3/4 w-full" />
      ))}
    </div>
  );
}

/** A titled block — one `Section` with its content area. */
export function SectionSkeleton({ height = 'h-40' }: { readonly height?: string }): React.ReactElement {
  return (
    <div className="space-y-3">
      <Skeleton className="h-5 w-44" />
      <Skeleton className={`w-full ${height}`} />
    </div>
  );
}
