import { formatHours, hours } from '@/server/games/hours';

/** Axis + tooltip label for a tenths-of-an-hour value. */
export function formatAxisHours(tenths: number): string {
  return formatHours(hours(Math.round(tenths)));
}

/**
 * A domain that always includes zero and never degenerates to a single value.
 * Recharts prints the same tick label five times when `dataMin === dataMax`.
 *
 * Deliberately separate from Finance's own `computeChartDomain`
 * (`src/features/finance/dashboard/charts/chart-utils.ts`) — see
 * `@/components/ui/chart-utils`'s doc comment for why the two were not
 * merged into one parameterized function.
 */
export function computeChartDomain(values: readonly number[]): [number, number] {
  if (values.length === 0) return [0, 10];

  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  if (max === min) return [min, min + 10];
  return [min, max];
}
