'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MONTH_ABBREVIATIONS } from '@/server/finance/grid';

/**
 * Additive, not competing: pushes the same `?year=&month=` URL shape the
 * grid table's own year `Select` already uses, so both stay in sync through
 * the URL rather than through shared component state. Navigation is never
 * clamped to months with data — a month with nothing imported yet is a
 * valid, useful thing to look at (it shows the dashboard's own empty state).
 *
 * `mode="year"` (the This Year tab) drops the month `Select` and steps
 * prev/next by a whole year instead of a month — one component, not a
 * second competing navigator, since both modes share the exact same
 * `?year=&month=` URL and the same "always enabled, never clamped to data"
 * navigation rule. The month stays whatever it already was in the URL so
 * switching back to Month view lands where the owner left it.
 */
export function MonthNavigator({
  year,
  month,
  years,
  mode = 'month',
}: {
  readonly year: number;
  readonly month: number;
  readonly years: readonly number[];
  readonly mode?: 'month' | 'year';
}): React.ReactElement {
  const router = useRouter();

  function go(nextYear: number, nextMonth: number): void {
    router.push(`/finance/monthly?year=${nextYear}&month=${nextMonth}`);
  }

  function goPrevious(): void {
    if (mode === 'year') {
      go(year - 1, month);
      return;
    }
    go(month === 1 ? year - 1 : year, month === 1 ? 12 : month - 1);
  }

  function goNext(): void {
    if (mode === 'year') {
      go(year + 1, month);
      return;
    }
    go(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1);
  }

  const yearsWithCurrent = years.includes(year) ? years : [year, ...years].sort((a, b) => b - a);

  return (
    <div className="flex items-center gap-1.5">
      <Button
        variant="outline"
        size="icon"
        aria-label={mode === 'year' ? 'Previous year' : 'Previous month'}
        onClick={goPrevious}
      >
        <ChevronLeft className="size-4" />
      </Button>

      {mode === 'month' ? (
        <Select value={String(month)} onValueChange={(value) => go(year, Number.parseInt(value, 10))}>
          <SelectTrigger aria-label="Month" className="w-28 font-medium">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MONTH_ABBREVIATIONS.map((label, index) => (
              <SelectItem key={label} value={String(index + 1)}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      <Select value={String(year)} onValueChange={(value) => go(Number.parseInt(value, 10), month)}>
        <SelectTrigger aria-label="Year" className="w-24 font-medium">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {yearsWithCurrent.map((y) => (
            <SelectItem key={y} value={String(y)}>
              {y}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button
        variant="outline"
        size="icon"
        aria-label={mode === 'year' ? 'Next year' : 'Next month'}
        onClick={goNext}
      >
        <ChevronRight className="size-4" />
      </Button>
    </div>
  );
}
