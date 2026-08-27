import { cn } from '@/lib/utils';

/**
 * The single row of filter controls a page is allowed, between its header
 * and its `PageMeta` line.
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
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
}): React.ReactElement {
  return <div className={cn('flex flex-wrap items-end gap-3', className)}>{children}</div>;
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
