import { cn } from '@/lib/utils';
import { cents, format } from '@/server/finance/money';

/**
 * Consistent presentation for a signed cents value: right-aligned, tabular
 * figures, no wrapping. This is display-only — every value passed in is
 * already the result of `src/server/finance/money.ts` arithmetic; this
 * component does no math of its own.
 */
export function Money({
  valueCents,
  flipSign = false,
  className,
}: {
  readonly valueCents: number;
  /** For income-kind figures, which store negative and display positive. */
  readonly flipSign?: boolean;
  readonly className?: string;
}): React.ReactElement {
  const displayCents = flipSign ? -valueCents : valueCents;
  return (
    // `block`, not the span default of `inline` — a table cell is a valid
    // containing block for it, so this fills the cell and `text-right`
    // aligns against the FULL column width, not just the text's own span.
    // Callers never need to remember to also right-align the <TableCell>.
    <span className={cn('tabular block text-right whitespace-nowrap', className)}>
      {format(cents(displayCents), { signed: true })}
    </span>
  );
}
