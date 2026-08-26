import { cn } from '@/lib/utils';

/**
 * A toggleable pill filter with a trailing count — Games' library filters
 * (status/platform) and Finance's import-review buckets (`All`/`Ready`/
 * `Needs attention`/...) were two near-identical implementations of the same
 * control. Adopts Games' sizing (`text-xs`, `font-medium`, a dimmed count)
 * per the shared-primitives consolidation — the smaller of the two former
 * variants, since it read better against a dense row of many chips.
 */
export function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  readonly label: string;
  readonly count: number;
  readonly active: boolean;
  readonly onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        active ? 'bg-foreground text-background border-transparent' : 'text-muted-foreground hover:bg-muted',
      )}
    >
      {label}
      <span className="tabular ml-1.5 opacity-60">{count}</span>
    </button>
  );
}
