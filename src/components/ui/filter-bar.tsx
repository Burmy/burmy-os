import { cn } from '@/lib/utils';

/**
 * The single row of filter controls a page is allowed, between its header
 * and its content.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE RULE, NOT ONE WIDGET.
 *
 * A filter with a handful of known options renders as chips with counts
 * (Library's status/platform — you can see how many of each you have without
 * opening anything). A filter with many or open-ended options renders as a
 * labeled `FilterSelect` (Year, Month, Category, Type). Both live in this
 * same bar, at the same height.
 *
 * What this replaced: three different filter patterns across four pages —
 * an inline search+chips row, an always-visible labeled select row, and a
 * collapsible "Filters" disclosure that hid three selects behind a click for
 * no reason. The disclosure is gone; nothing here is worth a click to reveal.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function FilterBar({
  children,
  className,
  pending = false,
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
  /**
   * A filter change is navigating. Renders a thin indeterminate line along the
   * bar's bottom edge — see `useNavigate` for why this feedback is local to the
   * controls rather than a bar at the top of the viewport.
   *
   * The line is absolutely positioned so its appearance cannot reflow the row
   * it belongs to; a filter bar that grows 2px taller the instant you use it
   * would be a worse jank than the silence it replaces.
   */
  readonly pending?: boolean;
}): React.ReactElement {
  return (
    <div className={cn('relative flex flex-wrap items-end gap-3', className)} aria-busy={pending || undefined}>
      {children}
      {pending ? (
        <span aria-hidden className="bg-muted absolute inset-x-0 -bottom-2 h-0.5 overflow-hidden rounded-full">
          <span className="bg-foreground/40 block h-full w-1/3 animate-[filter-bar-progress_1.1s_ease-in-out_infinite] rounded-full" />
        </span>
      ) : null}
    </div>
  );
}

/**
 * A labelled group inside `FilterBar` — the label sits above its control so
 * every control in the row shares one baseline regardless of whether it has
 * a label. Used directly for the search input; `FilterSelect` wraps it.
 */
export function FilterField({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="space-y-1.5">
      <span className="text-muted-foreground block text-xs">{label}</span>
      {children}
    </div>
  );
}
