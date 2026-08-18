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
    <div className="rounded-lg border bg-card p-4">
      <div className="text-muted-foreground text-sm">{label}</div>
      <div className={cn('tabular mt-1 text-2xl font-semibold whitespace-nowrap', valueClassName)}>{value}</div>
      {comparison ? <div className="mt-1.5">{comparison}</div> : null}
      {hint ? <div className="text-muted-foreground mt-1 text-xs">{hint}</div> : null}
    </div>
  );
}
