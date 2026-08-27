import { cn } from '@/lib/utils';

/**
 * Page-level heading: a title, an optional live-count slot on the title's own
 * baseline, and an optional actions slot flush right.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `meta` IS NOT THE OLD `subtitle` PROP COMING BACK.
 *
 * There used to be a `subtitle`, and it was doing three unrelated jobs at once:
 * a live count on Library ("180 games"), explanatory prose on Transactions/
 * Review/Upcoming, and nothing at all on Stats/Settings/Finance. That is why no
 * two page headers in this app looked alike, and removing it is what made them
 * consistent.
 *
 * Prose descriptions are still gone, permanently. The owner is the only user
 * and already knows what each screen does. (One of them had been shipping the
 * literal string "Anything M6 could not confidently resolve on its own,"
 * leaking an internal milestone codename into the UI.) **There is no prose slot
 * here and adding one re-opens exactly the drift that removal closed.**
 *
 * What `meta` takes is the live count line and nothing else — "180 games",
 * "438 transactions · 12 need review". It briefly lived in a separate
 * `PageMeta` component on its own row between the filters and the content, on
 * the theory that a number which is a RESULT of the filters belongs next to the
 * controls that change it. That reasoning was sound and the layout still lost:
 * one short grey line was costing ~64px of vertical band (32px above, 32px
 * below) on every page that had one, which real use called out as dead space.
 * Sitting it on the title's baseline costs nothing and reads fine.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `className` survives for the two detail pages (`finance/import/[importId]`,
 * `games/sync/[runId]`) that need a plain `mt-2` to sit closer to the
 * "← Back" link above them.
 */
export function PageHeader({
  title,
  meta,
  actions,
  className,
}: {
  readonly title: React.ReactNode;
  /**
   * The page's live count line. Rendered as separate children, each becoming
   * its own `·`-free segment with a real gap — pass `<span>`s, not one
   * pre-joined string, so the segments wrap independently on a narrow viewport.
   */
  readonly meta?: React.ReactNode;
  readonly actions?: React.ReactNode;
  readonly className?: string;
}): React.ReactElement {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-4', className)}>
      {/* `items-baseline` rather than `items-center`: at 36px the title dwarfs
          a 14px count, and centering the small text against the big text's box
          leaves it floating visibly above the title's own baseline. */}
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="font-display text-4xl font-medium tracking-tight">{title}</h1>
        {meta ? (
          <div className="text-muted-foreground flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">{meta}</div>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
