import { cn } from '@/lib/utils';

/**
 * One headline number — Income, Expenses, Net, Savings rate, Average daily
 * spending, Transactions. `value` is a fully-formatted string; this
 * component does no formatting or money math of its own, matching
 * `components/finance/money.tsx`'s own display-only boundary.
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
    <div className="flex h-full flex-col justify-between gap-2 rounded-lg border bg-card p-5">
      <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{label}</div>
      <div>
        <div className={cn('tabular text-[1.75rem] leading-none font-semibold whitespace-nowrap', valueClassName)}>
          {value}
        </div>
        {comparison ? <div className="mt-2">{comparison}</div> : null}
        {hint ? <div className="text-muted-foreground mt-2 text-xs">{hint}</div> : null}
      </div>
    </div>
  );
}
