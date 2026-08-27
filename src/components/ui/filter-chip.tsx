import { cn } from '@/lib/utils';

/**
 * A toggleable pill filter, optionally with a trailing count.
 *
 * Height is the app's single shared control height (36px, `h-9`) and radius
 * is the app's single 6px — the same as a `FilterSelect`, an `Input` and a
 * `Button`. Both used to differ (26px tall, fully-pill), which is why a chip
 * sitting next to a dropdown in the same filter row read as a different
 * kind of control. Nothing in a filter row overrides either any more; that
 * uniformity is the whole point.
 *
 * `count` is optional. Games' status/platform chips have a genuinely useful
 * count; some filters have none available, and a chip without one is still
 * a perfectly good toggle.
 */
export function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  readonly label: string;
  readonly count?: number;
  readonly active: boolean;
  readonly onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        // Borderless: the resting chip carries a tonal fill, the active one
        // flips to full foreground/background contrast. Part of the app-wide
        // "fewer borders" pass — the fill is the affordance now.
        'inline-flex h-9 shrink-0 items-center rounded-md px-4 text-sm font-medium transition-colors',
        active ? 'bg-foreground text-background' : 'bg-card text-muted-foreground hover:bg-muted',
      )}
    >
      {label}
      {count === undefined ? null : <span className="tabular ml-2 opacity-60">{count}</span>}
    </button>
  );
}
