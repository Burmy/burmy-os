'use client';

import { Plus, Trophy, X } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { InlineEditField, ROW_CLASS } from '@/components/ui/inline-edit-row';
import { toast } from '@/components/ui/toast';
import type { ActionResult } from '@/features/games/action-result';
import { cn } from '@/lib/utils';
import { formatHours, fromHoursInput, hours, toHoursInput } from '@/server/games/hours';
import {
  type PlayYearDraft,
  findDuplicateYear,
  validateSplit,
  validateTrophySplit,
} from '@/server/games/play-years';

/**
 * "First played", and the years the game's hours were played in, as rows.
 *
 * The split used to hide behind a "Split across years" button that opened an
 * editor with its own Save. The owner's ask: "just have a plus sign next to
 * the year." So: the First played row carries a + while there is no split;
 * pressing it turns the split into ordinary rows — one per year, year, hours
 * and trophies each click-to-edit like every other cell in the panel, an x
 * on each, a + on the last. There is no Save button: every change is a local
 * draft, and the moment the drafts are complete, free of duplicate years and
 * add up to the game's own hours (and, when any trophies cell is filled, to
 * its trophies earned), they save themselves; until then one quiet line says
 * what is still off. A split is of the BASE game's hours and trophies — DLC
 * has its own year and never enters it.
 *
 * Trophies joined the rows on 2026-10-19 ("I also need it for trophies for
 * stats"): the sheet's "33 + 13" meant 33 earned in 2024 and 13 in 2025, and
 * the year-by-year table has to say so. A row's trophies cell may stay blank
 * — a split that only says hours leaves every trophy on First played.
 */
export function PlayYearsRows({
  hoursTenths,
  achievementsUnlocked,
  firstPlayedYear,
  playYears,
  onSaveFirstPlayed,
  onSave,
}: {
  /** The base game's hours — what the years must add up to. */
  readonly hoursTenths: number | null;
  /** The base game's trophies earned — what the years' trophies must add up to, once any is filled. */
  readonly achievementsUnlocked: number | null;
  readonly firstPlayedYear: number | null;
  readonly playYears: readonly {
    readonly year: number;
    readonly hoursTenths: number;
    readonly achievementsUnlocked: number | null;
  }[];
  readonly onSaveFirstPlayed: (value: string) => Promise<ActionResult>;
  readonly onSave: (drafts: readonly PlayYearDraft[]) => Promise<ActionResult>;
}): React.ReactElement {
  const fromProps = (): PlayYearDraft[] =>
    playYears.map((row) => ({
      year: String(row.year),
      hours: toHoursInput(hours(row.hoursTenths)),
      trophies: row.achievementsUnlocked === null ? '' : String(row.achievementsUnlocked),
    }));
  const [drafts, setDrafts] = useState<readonly PlayYearDraft[]>(fromProps);
  const [justAdded, setJustAdded] = useState<number | null>(null);

  // Resync from the server's copy when it changes (a save re-fetched the
  // game) — compared DURING render, the pattern CLAUDE.md records, not in an
  // effect.
  const serverKey = playYears
    .map((row) => `${row.year}=${row.hoursTenths}/${row.achievementsUnlocked ?? ''}`)
    .join(',');
  const [seenKey, setSeenKey] = useState(serverKey);
  if (seenKey !== serverKey) {
    setSeenKey(serverKey);
    setDrafts(fromProps());
    setJustAdded(null);
  }

  const problem = describeProblem(drafts, hoursTenths ?? 0, achievementsUnlocked);

  async function commit(next: readonly PlayYearDraft[]): Promise<void> {
    setDrafts(next);
    if (next.length > 0 && describeProblem(next, hoursTenths ?? 0, achievementsUnlocked) !== null)
      return;
    // A Server Action that THROWS (rather than returning a failure) rejects
    // this await — the drafts would sit here looking saved and vanish on the
    // next switch, with nothing on screen. Say so. (CLAUDE.md: a rejecting
    // action skips everything after its await.)
    try {
      const result = await onSave(next);
      if (!result.ok) toast.error(result.error);
    } catch {
      toast.error('The years could not be saved — try again.');
    }
  }

  function addYear(): void {
    const base = hoursTenths ?? 0;
    const lastYear =
      drafts.length === 0
        ? (firstPlayedYear ?? new Date().getUTCFullYear())
        : Number(drafts[drafts.length - 1]!.year) || new Date().getUTCFullYear();
    const next =
      drafts.length === 0
        ? [
            {
              year: String(firstPlayedYear ?? ''),
              hours: toHoursInput(hours(base)),
              trophies: '',
            },
            { year: String(lastYear + 1), hours: '', trophies: '' },
          ]
        : [...drafts, { year: String(lastYear + 1), hours: '', trophies: '' }];
    setDrafts(next);
    setJustAdded(next.length - 1);
  }

  function update(index: number, patch: Partial<PlayYearDraft>): void {
    void commit(drafts.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function remove(index: number): void {
    void commit(drafts.filter((_, i) => i !== index));
  }

  return (
    <>
      <div className={cn(ROW_CLASS, 'items-center')}>
        <span className="text-muted-foreground">First played</span>
        <span className="flex items-center gap-2">
          <InlineEditField
            hideLabel
            label="First played"
            value={firstPlayedYear === null ? '' : String(firstPlayedYear)}
            placeholder="Not set"
            onSave={onSaveFirstPlayed}
          />
          {drafts.length === 0 ? <AddYearButton onClick={addYear} /> : null}
        </span>
      </div>

      {drafts.map((row, index) => {
        const yearLabel = row.year.trim() === '' ? `year ${index + 1}` : row.year;
        return (
          // Index-keyed deliberately: rows have no id until saved and cannot
          // be reordered, only added and removed.
          <div key={index} className={cn(ROW_CLASS, 'items-center')}>
            <span className="text-muted-foreground">{index === 0 ? 'Years' : ''}</span>
            <span className="flex items-center gap-2">
              <span className="w-12">
                <InlineEditField
                  hideLabel
                  label={`Year ${index + 1}`}
                  value={row.year}
                  placeholder="Year"
                  onSave={async (value) => {
                    update(index, { year: value });
                    return { ok: true };
                  }}
                />
              </span>
              <span className="w-16">
                <InlineEditField
                  hideLabel
                  label={`Hours in ${yearLabel}`}
                  value={row.hours}
                  displayValue={
                    fromHoursInput(row.hours) === null
                      ? undefined
                      : formatHours(hours(fromHoursInput(row.hours) ?? 0))
                  }
                  placeholder="— h"
                  initiallyEditing={justAdded === index}
                  onSave={async (value) => {
                    update(index, { hours: value });
                    return { ok: true };
                  }}
                />
              </span>
              {/* Trophies earned that year. The small cup says what the number
                  is without a column heading; blank reads "—", which is the
                  honest state for a split that only says hours. */}
              <span className="flex w-16 items-center gap-1">
                <InlineEditField
                  hideLabel
                  label={`Trophies in ${yearLabel}`}
                  value={row.trophies}
                  placeholder="—"
                  onSave={async (value) => {
                    update(index, { trophies: value });
                    return { ok: true };
                  }}
                />
                <Trophy className="text-muted-foreground size-3 shrink-0" aria-hidden />
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove ${yearLabel}`}
                className="text-muted-foreground size-6"
                onClick={() => remove(index)}
              >
                <X className="size-3.5" aria-hidden />
              </Button>
              {index === drafts.length - 1 ? <AddYearButton onClick={addYear} /> : null}
            </span>
          </div>
        );
      })}

      {drafts.length > 0 && problem !== null ? (
        <div className={ROW_CLASS}>
          <span />
          <span className="text-destructive text-xs">{problem}</span>
        </div>
      ) : null}
    </>
  );
}

function AddYearButton({ onClick }: { readonly onClick: () => void }): React.ReactElement {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Add a year"
      className="text-muted-foreground size-6"
      onClick={onClick}
    >
      <Plus className="size-3.5" aria-hidden />
    </Button>
  );
}

/** Why the drafts cannot be saved yet, in one short sentence — or `null`. */
function describeProblem(
  drafts: readonly PlayYearDraft[],
  baseTenths: number,
  earned: number | null,
): string | null {
  for (const row of drafts) {
    if (row.year.trim() === '') return 'Enter a year';
    if (!/^\d{4}$/.test(row.year.trim())) return `${row.year} is not a year`;
    if (row.hours.trim() === '') return `Enter the hours for ${row.year}`;
    if (fromHoursInput(row.hours) === null) return `${row.hours} is not a number of hours`;
    if (row.trophies.trim() !== '' && !/^\d+$/.test(row.trophies.trim()))
      return `${row.trophies} is not a number of trophies`;
  }
  const duplicate = findDuplicateYear(drafts.map((row) => ({ year: Number(row.year) })));
  if (duplicate !== null) return `${duplicate} appears twice`;
  const validation = validateSplit(
    baseTenths,
    drafts.map((row) => ({ hoursTenths: fromHoursInput(row.hours) ?? 0 })),
  );
  if (!validation.ok) {
    return `Years add up to ${formatHours(hours(validation.splitTenths))}; hours are ${formatHours(hours(baseTenths))}`;
  }
  const trophies = validateTrophySplit(
    earned,
    drafts.map((row) => ({
      achievementsUnlocked: row.trophies.trim() === '' ? null : Number(row.trophies),
    })),
  );
  if (!trophies.ok) {
    return `Trophies add up to ${trophies.splitUnlocked}; earned is ${trophies.earned}`;
  }
  return null;
}
