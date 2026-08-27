import { cn } from '@/lib/utils';

/**
 * The one live line a page is allowed between its filters and its content:
 * a count, a state, whatever the active filters currently add up to
 * ("180 games", "438 transactions · 12 need review"). Optionally with one
 * trailing action flush right (Transactions' Export link).
 *
 * It sits BELOW the filter bar and directly above the content on purpose —
 * the number it prints is a result of the filters, so it belongs next to the
 * controls that change it rather than in `PageHeader`, which never changes.
 * See that component's own doc comment for why the old `subtitle` prop that
 * used to carry this was removed.
 *
 * Exists as a component rather than a repeated `<p className="…">` because
 * five hand-rolled near-copies of this line is precisely how the app's
 * headers drifted apart in the first place.
 */
export function PageMeta({
  children,
  actions,
  className,
}: {
  readonly children: React.ReactNode;
  readonly actions?: React.ReactNode;
  readonly className?: string;
}): React.ReactElement {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-x-4 gap-y-1', className)}>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">{children}</div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
