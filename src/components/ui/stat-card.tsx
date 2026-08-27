import { cn } from '@/lib/utils';

/**
 * One headline number — Finance's Income/Expenses/Net/Savings rate cards and
 * Games' Games/Hours played/Platinums cards are the same component; only the
 * label, formatted value string, and optional hint/comparison differ. `value`
 * is a fully-formatted string; this component does no formatting or math of
 * its own, matching `components/finance/money.tsx`'s own display-only
 * boundary.
 *
 * `truncate` + a `title` attribute on the value guard against a long
 * computed string (a developer name, a wide dollar figure) pushing the card
 * wider than its grid cell — it clips with an ellipsis and the full value is
 * still reachable on hover, exactly like Games' own stat cards did before
 * this became shared.
 *
 * No border, `bg-card`, `p-6` — the same borderless/tonal/padding treatment
 * `Section` uses, so the app's two shared "card" primitives read as one
 * consistent language across both Finance and Games.
 */
export function StatCard({
  label,
  value,
  valueClassName,
  comparison,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly valueClassName?: string;
  readonly comparison?: React.ReactNode;
  readonly hint?: string;
}): React.ReactElement {
  return (
    <div className="flex h-full flex-col justify-between gap-2 rounded-lg bg-card p-6">
      <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{label}</div>
      <div>
        <div
          className={cn('tabular truncate text-[1.75rem] leading-none font-semibold', valueClassName)}
          title={value}
        >
          {value}
        </div>
        {comparison ? <div className="mt-2">{comparison}</div> : null}
        {hint ? <div className="text-muted-foreground mt-2 text-xs">{hint}</div> : null}
      </div>
    </div>
  );
}
