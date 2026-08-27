import { cn } from '@/lib/utils';

/**
 * Page-level heading: a title and an optional actions slot flush right.
 * That is the whole contract — deliberately.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THERE IS NO `subtitle` PROP, ON PURPOSE.
 *
 * There used to be, and it was doing three unrelated jobs at once: a live
 * count on Library ("180 games"), explanatory prose on Transactions/Review/
 * Upcoming, and nothing at all on Stats/Settings/Finance. That is why no two
 * page headers in this app looked alike.
 *
 * Prose descriptions were deleted outright — the owner is the only user and
 * already knows what each screen does. (One of them had been shipping the
 * literal string "Anything M6 could not confidently resolve on its own,"
 * leaking an internal milestone codename into the UI.)
 *
 * Live counts moved DOWN into `PageMeta`, which sits below the filters and
 * directly above the content. That placement is the point: the number is a
 * RESULT of the active filters, so it belongs next to the controls that
 * change it, not in a header that never changes.
 *
 * If a page needs to say something, it says it in `PageMeta`. Adding a
 * subtitle back here re-opens the exact drift this removal closed.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `className` survives for the two detail pages (`finance/import/[importId]`,
 * `games/sync/[runId]`) that need a plain `mt-2` to sit closer to the
 * "← Back" link above them.
 */
export function PageHeader({
  title,
  actions,
  className,
}: {
  readonly title: React.ReactNode;
  readonly actions?: React.ReactNode;
  readonly className?: string;
}): React.ReactElement {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-4', className)}>
      <h1 className="font-display text-4xl font-medium tracking-tight">{title}</h1>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
