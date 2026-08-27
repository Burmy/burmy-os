'use client';

import { Plus, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatHours, fromHoursInput, hours } from '@/server/games/hours';
import { validateSplit } from '@/server/games/play-years';

/** Draft state is TEXT, not numbers — a half-typed "2" must not become year 2. */
export interface PlayYearDraft {
  readonly year: string;
  readonly hours: string;
}

/**
 * A draft row counts as real — and must reach the server — unless it is
 * COMPLETELY empty (both `year` and `hours` blank after trimming). That is
 * the only state that means "clicked Add a year, then changed my mind."
 *
 * This is the ONE place that decides which rows count. Before this existed,
 * this panel's live validation counted every row while `game-dialog.tsx`
 * separately dropped any row with a blank year before submitting — two
 * independent opinions about the same drafts, which could show "49h of 49h"
 * on screen while silently submitting a mismatched (or even empty) split.
 * Both the live validation below and the dialog's FormData serialization
 * must call this same function; a partially filled row (year without hours,
 * or hours without year) is deliberately NOT dropped here — it has to reach
 * the server so `playYearsSchema` in `game-actions.ts` rejects it explicitly
 * instead of vanishing client-side.
 */
export function isRealPlayYearDraft(row: PlayYearDraft): boolean {
  return row.year.trim() !== '' || row.hours.trim() !== '';
}

/**
 * Optional per-year breakdown of a game's hours.
 *
 * Used by roughly 3 games out of 160, so it stays collapsed and out of the way
 * by default (the dialog owns that). The total remains the single number the
 * owner edits normally; these rows only say WHICH YEARS it happened in, which
 * is why the sum is validated against the total rather than replacing it.
 */
export function PlayYearsPanel({
  value,
  onChange,
  totalTenths,
}: {
  readonly value: readonly PlayYearDraft[];
  readonly onChange: (next: readonly PlayYearDraft[]) => void;
  readonly totalTenths: number;
}): React.ReactElement {
  // Only rows `isRealPlayYearDraft` also counts feed the sum — this must be
  // the exact same rule the dialog uses to decide what gets submitted, or
  // the on-screen "Xh of Yh" can say OK while a different set of rows ships.
  const parsed = value.filter(isRealPlayYearDraft).map((row) => ({ hoursTenths: fromHoursInput(row.hours) ?? 0 }));
  const validation = validateSplit(totalTenths, parsed);

  function update(index: number, patch: Partial<PlayYearDraft>): void {
    onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  return (
    <div className="space-y-2">
      {value.map((row, index) => (
        // Index-keyed deliberately: these rows have no stable id until saved,
        // and reordering is not possible in this UI — only add and remove.
        <div key={index} className="flex items-end gap-2">
          <div className="w-28 space-y-1">
            <Label htmlFor={`play-year-${index}`} className="text-xs">
              Year
            </Label>
            <Input
              id={`play-year-${index}`}
              value={row.year}
              onChange={(event) => update(index, { year: event.target.value })}
              placeholder="2025"
              inputMode="numeric"
            />
          </div>
          <div className="w-28 space-y-1">
            <Label htmlFor={`play-hours-${index}`} className="text-xs">
              Hours
            </Label>
            <Input
              id={`play-hours-${index}`}
              value={row.hours}
              onChange={(event) => update(index, { hours: event.target.value })}
              placeholder="12"
              inputMode="decimal"
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove year ${row.year === '' ? index + 1 : row.year}`}
            onClick={() => onChange(value.filter((_, i) => i !== index))}
          >
            <X className="size-4" />
          </Button>
        </div>
      ))}

      <div className="flex items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...value, { year: '', hours: '' }])}>
          <Plus className="mr-1 size-4" />
          Add a year
        </Button>
        {value.length === 0 ? null : (
          <span className="text-muted-foreground text-xs">
            {formatHours(hours(validation.splitTenths))} of {formatHours(hours(totalTenths))}
          </span>
        )}
      </div>

      {validation.ok ? null : (
        <p role="alert" className="text-destructive text-xs">
          {validation.differenceTenths > 0
            ? `${formatHours(hours(validation.differenceTenths))} not yet assigned to a year.`
            : `Split is over the total by ${formatHours(hours(Math.abs(validation.differenceTenths)))}.`}
        </p>
      )}
    </div>
  );
}
