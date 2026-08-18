/**
 * The one percent formatter for the Finance dashboard — `Intl.NumberFormat`'s
 * own `style: 'percent'`, not a hand-rolled `${n}%` string. Every dashboard
 * function that produces a percentage (`computeSavingsRate`,
 * `compareToPreviousMonth`'s `deltaPercent`, `CategoryAmount.percentOfExpenses`)
 * returns it in PERCENTAGE POINTS (`8.4` meaning "8.4%"), so this divides by
 * 100 before handing it to `Intl.NumberFormat`, which expects a fraction.
 */
export function formatPercent(percentPoints: number, options: { readonly signed?: boolean } = {}): string {
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'percent',
    maximumFractionDigits: 1,
    signDisplay: options.signed ? 'exceptZero' : 'auto',
  });
  return formatter.format(percentPoints / 100);
}
