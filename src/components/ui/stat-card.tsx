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
  // `gap-2` stacking from the top, NOT `justify-between`. Grid rows stretch
  // every card to the tallest in the row, and `justify-between` then pushed the
  // value block to the FLOOR of that stretched box. On a row where one card
  // carries two comparison lines and another carries none, "Savings rate" ended
  // up with its 29.2% floating an inch below its own label — a rendering fault,
  // not a layout. Stacking from the top keeps a value under its label whatever
  // its neighbours contain.
  // ONE HEIGHT EVERYWHERE (owner, 2026-10-19: "make sure all the cards are the
  // same size"). `min-h-46` (184px) is the MEASURED height of the tallest card
  // — label, value, an arrow line and a hint — taken from a real browser, not
  // computed from the type scale. A grid with `auto-rows-fr` already stretches
  // every card in it to its tallest sibling; the minimum is what keeps a grid
  // of hint-only cards (Insights, the Games callouts) level with the grid of
  // fuller cards above it instead of sitting visibly shorter.
  // `StatCardGridSkeleton` draws the same 184px.
  return (
    <div className="flex h-full min-h-46 flex-col gap-3 rounded-md bg-card p-8">
      <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {label}
      </div>
      <div>
        <div
          className={cn('tabular truncate text-[2rem] leading-none font-semibold', valueClassName)}
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
