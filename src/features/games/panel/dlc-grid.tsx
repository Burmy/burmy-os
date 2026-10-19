'use client';

import { Check, Plus, X } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InlineEditField, ROW_CLASS } from '@/components/ui/inline-edit-row';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import type { ActionResult } from '@/features/games/action-result';
import {
  createGameDlcAction,
  deleteGameDlcAction,
  updateGameDlcAction,
} from '@/features/games/dlc-actions';
import type { GameFieldKey } from '@/features/games/game-actions';
import { cn } from '@/lib/utils';
import type { Game } from '@/server/db/games/games';
import type { GameDlcRow } from '@/server/games/dlc';
import { formatHours, hours, toHoursInput } from '@/server/games/hours';

/**
 * The game's parts — the base game and each DLC — as rows that look like
 * every other row in the panel: the part's name sits in the grey label
 * column, and its figures line up in the value column under one small
 * header (Year / Hours / Price / Trophies). Every cell is click-to-edit in
 * place; nothing opens a modal. The rows only exist while the game has DLC
 * (or one is being added) — with none, the panel's own rows ARE the base
 * game and a plain "+ Add DLC" row is all that shows.
 *
 * A DLC cell saves the WHOLE row (`updateGameDlcAction`) with that one cell
 * changed; a base-game cell goes through the ordinary per-field action the
 * panel's rows use. DLC is additive — `src/server/games/dlc.ts`. (Earlier
 * shapes — inline cells on one line, a dialog, a boxed grid, an indented
 * grid — were each rejected on sight; this one is "three more rows".)
 */
export function DlcGrid({
  game,
  onSaveField,
  onChanged,
}: {
  readonly game: Game;
  readonly onSaveField: (field: GameFieldKey, value: string) => Promise<ActionResult>;
  readonly onChanged: () => void;
}): React.ReactElement {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newYear, setNewYear] = useState('');
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<GameDlcRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function saveCell(
    row: GameDlcRow,
    field:
      'name' | 'year' | 'hours' | 'priceDollars' | 'achievementsUnlocked' | 'achievementsTotal',
    value: string,
  ): Promise<ActionResult> {
    const formData = rowFormData(row);
    formData.set(field, value);
    const result = await updateGameDlcAction(row.id, formData);
    if (result.ok) onChanged();
    return result;
  }

  async function addNew(): Promise<void> {
    // try/catch/finally, not a bare await: a rejecting action would otherwise
    // leave the inputs disabled with no error shown.
    setSaving(true);
    try {
      const formData = new FormData();
      formData.set('name', newName);
      formData.set('year', newYear);
      const result = await createGameDlcAction(game.id, formData);
      if (result.ok) {
        setAdding(false);
        setNewName('');
        setNewYear('');
        onChanged();
      } else {
        toast.error(result.error);
      }
    } catch {
      toast.error('The DLC could not be added. Try again.');
    } finally {
      setSaving(false);
    }
  }

  async function remove(): Promise<void> {
    if (removing === null) return;
    setDeleting(true);
    try {
      const result = await deleteGameDlcAction(removing.id);
      if (result.ok) {
        toast.success(`${removing.name} removed`);
        setRemoving(null);
        onChanged();
      } else {
        toast.error(result.error);
      }
    } catch {
      toast.error('The DLC could not be removed. Try again.');
    } finally {
      setDeleting(false);
    }
  }

  const showGrid = game.dlc.length > 0 || adding;

  return (
    <>
      {showGrid ? (
        <div className="overflow-x-auto">
          {/* A table so the figures are real columns with real headers, laid
              out on the panel's own 9rem label track: the first column IS the
              label column, so a part reads as a row like any other. */}
          <table className="w-full border-collapse text-sm">
            <colgroup>
              <col className="w-36" />
              <col />
              <col />
              <col />
              <col />
              <col className="w-6" />
            </colgroup>
            <thead>
              <tr className="text-muted-foreground h-9 text-xs">
                <th scope="col" className="text-left font-normal">
                  <span className="sr-only">Part</span>
                </th>
                <th scope="col" className="pr-3 text-right font-normal">
                  Year
                </th>
                <th scope="col" className="pr-3 text-right font-normal">
                  Hours
                </th>
                <th scope="col" className="pr-3 text-right font-normal">
                  Price
                </th>
                <th scope="col" className="text-right font-normal">
                  Trophies
                </th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {game.dlc.length === 0 ? null : (
                <tr className="h-9">
                  <td className="text-muted-foreground pr-3">Base game</td>
                  {/* The base game's year IS First played — one field, shown
                      in both places, saved through the same action. */}
                  <Cell>
                    <InlineEditField
                      hideLabel
                      label="Base game: year"
                      value={game.firstPlayedYear === null ? '' : String(game.firstPlayedYear)}
                      placeholder="—"
                      onSave={(value) => onSaveField('firstPlayedYear', value)}
                    />
                  </Cell>
                  <Cell>
                    <InlineEditField
                      hideLabel
                      label="Base game: hours"
                      value={game.hoursTenths === null ? '' : String(game.hoursTenths / 10)}
                      displayValue={
                        game.hoursTenths === null ? undefined : formatHours(hours(game.hoursTenths))
                      }
                      placeholder="—"
                      onSave={(value) => onSaveField('hours', value)}
                    />
                  </Cell>
                  <Cell>
                    <InlineEditField
                      hideLabel
                      label="Base game: price"
                      value={game.priceCents === null ? '' : (game.priceCents / 100).toFixed(2)}
                      displayValue={
                        game.priceCents === null ? undefined : formatPrice(game.priceCents)
                      }
                      placeholder="—"
                      onSave={(value) => onSaveField('priceDollars', value)}
                    />
                  </Cell>
                  <Cell last>
                    <InlineEditField
                      hideLabel
                      label="Base game: trophies earned"
                      value={
                        game.achievementsUnlocked === null ? '' : String(game.achievementsUnlocked)
                      }
                      placeholder="—"
                      onSave={(value) => onSaveField('achievementsUnlocked', value)}
                    />
                    <span className="text-muted-foreground" aria-hidden>
                      /
                    </span>
                    <InlineEditField
                      hideLabel
                      label="Base game: trophies total"
                      value={game.achievementsTotal === null ? '' : String(game.achievementsTotal)}
                      placeholder="—"
                      onSave={(value) => onSaveField('achievementsTotal', value)}
                    />
                  </Cell>
                  <td />
                </tr>
              )}
              {game.dlc.map((row) => (
                <tr key={row.id} className="h-9">
                  <td className="text-muted-foreground pr-3">
                    <InlineEditField
                      hideLabel
                      label={`${row.name}: name`}
                      value={row.name}
                      onSave={(value) => saveCell(row, 'name', value)}
                    />
                  </td>
                  <Cell>
                    <InlineEditField
                      hideLabel
                      label={`${row.name}: year`}
                      value={String(row.year)}
                      onSave={(value) => saveCell(row, 'year', value)}
                    />
                  </Cell>
                  <Cell>
                    <InlineEditField
                      hideLabel
                      label={`${row.name}: hours`}
                      value={row.hoursTenths === null ? '' : String(row.hoursTenths / 10)}
                      displayValue={
                        row.hoursTenths === null ? undefined : formatHours(hours(row.hoursTenths))
                      }
                      placeholder="—"
                      onSave={(value) => saveCell(row, 'hours', value)}
                    />
                  </Cell>
                  <Cell>
                    <InlineEditField
                      hideLabel
                      label={`${row.name}: price`}
                      value={row.priceCents === null ? '' : (row.priceCents / 100).toFixed(2)}
                      displayValue={
                        row.priceCents === null ? undefined : formatPrice(row.priceCents)
                      }
                      placeholder="—"
                      onSave={(value) => saveCell(row, 'priceDollars', value)}
                    />
                  </Cell>
                  <Cell last>
                    <InlineEditField
                      hideLabel
                      label={`${row.name}: trophies earned`}
                      value={
                        row.achievementsUnlocked === null ? '' : String(row.achievementsUnlocked)
                      }
                      placeholder="—"
                      onSave={(value) => saveCell(row, 'achievementsUnlocked', value)}
                    />
                    <span className="text-muted-foreground" aria-hidden>
                      /
                    </span>
                    <InlineEditField
                      hideLabel
                      label={`${row.name}: trophies total`}
                      value={row.achievementsTotal === null ? '' : String(row.achievementsTotal)}
                      placeholder="—"
                      onSave={(value) => saveCell(row, 'achievementsTotal', value)}
                    />
                  </Cell>
                  <td className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${row.name}`}
                      className="text-muted-foreground size-6"
                      onClick={() => setRemoving(row)}
                    >
                      <X className="size-3.5" aria-hidden />
                    </Button>
                  </td>
                </tr>
              ))}
              {adding ? (
                <tr className="h-9">
                  <td className="pr-3">
                    <Input
                      aria-label="New DLC name"
                      placeholder="Name"
                      value={newName}
                      autoFocus
                      disabled={saving}
                      className="h-7"
                      onChange={(event) => setNewName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') setAdding(false);
                      }}
                    />
                  </td>
                  <td className="pr-3">
                    <Input
                      aria-label="New DLC year"
                      placeholder="Year"
                      inputMode="numeric"
                      value={newYear}
                      disabled={saving}
                      className="h-7 w-16"
                      onChange={(event) => setNewYear(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void addNew();
                        if (event.key === 'Escape') setAdding(false);
                      }}
                    />
                  </td>
                  <td colSpan={3} />
                  <td className="text-right whitespace-nowrap">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Save new DLC"
                      className="size-6"
                      disabled={saving}
                      onClick={() => void addNew()}
                    >
                      <Check className="size-3.5" aria-hidden />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Cancel new DLC"
                      className="text-muted-foreground size-6"
                      disabled={saving}
                      onClick={() => setAdding(false)}
                    >
                      <X className="size-3.5" aria-hidden />
                    </Button>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {adding ? null : (
        <div className={cn(ROW_CLASS, 'grid-cols-1')}>
          <button
            type="button"
            aria-label="Add DLC"
            onClick={() => setAdding(true)}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 transition-colors"
          >
            <Plus className="size-3.5" aria-hidden />
            Add DLC
          </button>
        </div>
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setRemoving(null);
        }}
        title={`Remove ${removing?.name ?? 'this DLC'}?`}
        description="Its hours, price and trophies come off the game's totals. This cannot be undone."
        confirmLabel="Remove"
        destructive
        onConfirm={() => void remove()}
      />
    </>
  );
}

function Cell({
  children,
  last = false,
}: {
  readonly children: React.ReactNode;
  readonly last?: boolean;
}): React.ReactElement {
  return (
    <td className={last ? 'text-right' : 'pr-3 text-right'}>
      <span className="inline-flex items-center justify-end gap-0.5 tabular-nums">{children}</span>
    </td>
  );
}

function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** The row as the action's form expects it — every cell, in form units. */
function rowFormData(row: GameDlcRow): FormData {
  const formData = new FormData();
  formData.set('name', row.name);
  formData.set('year', String(row.year));
  formData.set('hours', row.hoursTenths === null ? '' : toHoursInput(hours(row.hoursTenths)));
  formData.set('priceDollars', row.priceCents === null ? '' : (row.priceCents / 100).toFixed(2));
  formData.set(
    'achievementsUnlocked',
    row.achievementsUnlocked === null ? '' : String(row.achievementsUnlocked),
  );
  formData.set(
    'achievementsTotal',
    row.achievementsTotal === null ? '' : String(row.achievementsTotal),
  );
  return formData;
}
