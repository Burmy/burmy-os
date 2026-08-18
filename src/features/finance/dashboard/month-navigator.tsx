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
 */
export function MonthNavigator({
  year,
  month,
  years,
}: {
  readonly year: number;
  readonly month: number;
  readonly years: readonly number[];
}): React.ReactElement {
  const router = useRouter();

  function go(nextYear: number, nextMonth: number): void {
    router.push(`/finance/monthly?year=${nextYear}&month=${nextMonth}`);
  }

  function goPrevious(): void {
    go(month === 1 ? year - 1 : year, month === 1 ? 12 : month - 1);
  }

  function goNext(): void {
    go(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1);
  }

  const yearsWithCurrent = years.includes(year) ? years : [year, ...years].sort((a, b) => b - a);

  return (
    <div className="flex items-center gap-1.5">
      <Button variant="outline" size="icon" className="size-8" aria-label="Previous month" onClick={goPrevious}>
        <ChevronLeft className="size-4" />
      </Button>

      <Select value={String(month)} onValueChange={(value) => go(year, Number.parseInt(value, 10))}>
        <SelectTrigger aria-label="Month" className="h-8 w-28 font-medium">
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

      <Select value={String(year)} onValueChange={(value) => go(Number.parseInt(value, 10), month)}>
        <SelectTrigger aria-label="Year" className="h-8 w-24 font-medium">
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

      <Button variant="outline" size="icon" className="size-8" aria-label="Next month" onClick={goNext}>
        <ChevronRight className="size-4" />
      </Button>
    </div>
  );
}
