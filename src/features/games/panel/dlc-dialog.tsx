'use client';

import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import type { ActionResult } from '@/features/games/action-result';
import {
  createGameDlcAction,
  deleteGameDlcAction,
  updateGameDlcAction,
} from '@/features/games/dlc-actions';
import { Field } from '@/features/games/field-controls';
import { updateGameFieldAction } from '@/features/games/game-actions';
import type { GameDlcRow, Totalable } from '@/server/games/dlc';
import { hours, toHoursInput } from '@/server/games/hours';

/**
 * What the dialog is editing. Three targets, one form:
 *
 *   - `add`  — a new DLC on the game: name, year, figures.
 *   - `edit` — an existing DLC, pre-filled, with Remove.
 *   - `base` — the game's OWN figures while it has DLC. The panel's Hours /
 *     Price / Trophies rows show base + DLC totals and are read-only then,
 *     so the base is edited here, on its own line, through the same
 *     per-field action the rows use when there is no DLC.
 */
export type DlcDialogTarget =
  | { readonly kind: 'add' }
  | { readonly kind: 'edit'; readonly dlc: GameDlcRow }
  | { readonly kind: 'base'; readonly game: Totalable };

function dollars(cents: number | null): string | undefined {
  return cents === null ? undefined : (cents / 100).toFixed(2);
}

function hoursText(tenths: number | null): string | undefined {
  return tenths === null ? undefined : toHoursInput(hours(tenths));
}

/** `defaultValue` only when there is one — `exactOptionalPropertyTypes`. */
function initial(value: string | number | undefined): { defaultValue?: string | number } {
  return value === undefined ? {} : { defaultValue: value };
}

export function DlcDialog({
  gameId,
  target,
  onOpenChange,
  onChanged,
}: {
  readonly gameId: string;
  readonly target: DlcDialogTarget;
  readonly onOpenChange: (open: boolean) => void;
  /** After any successful write, so the panel re-fetches its copy of the game. */
  readonly onChanged: () => void;
}): React.ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  const title =
    target.kind === 'add' ? 'Add DLC' : target.kind === 'edit' ? target.dlc.name : 'Base game';
  const figures: Totalable | null =
    target.kind === 'edit' ? target.dlc : target.kind === 'base' ? target.game : null;

  function submit(formData: FormData): void {
    setError(null);
    startTransition(async () => {
      const result = await save(formData);
      if (result.ok) {
        onChanged();
        onOpenChange(false);
        return;
      }
      setError(result.error);
    });
  }

  async function save(formData: FormData): Promise<ActionResult> {
    if (target.kind === 'add') return createGameDlcAction(gameId, formData);
    if (target.kind === 'edit') return updateGameDlcAction(target.dlc.id, formData);
    // The base figures are four ordinary game fields; an empty box clears one,
    // exactly as the inline rows do. Stop at the first failure so its message
    // names the field that refused.
    for (const field of [
      'hours',
      'priceDollars',
      'achievementsUnlocked',
      'achievementsTotal',
    ] as const) {
      const raw = formData.get(field);
      const result = await updateGameFieldAction(gameId, field, typeof raw === 'string' ? raw : '');
      if (!result.ok) return result;
    }
    return { ok: true };
  }

  async function remove(): Promise<void> {
    if (target.kind !== 'edit') return;
    // try/catch/finally, not a bare await: a rejecting action would otherwise
    // leave the button dead with no error shown.
    setRemoving(true);
    try {
      const result = await deleteGameDlcAction(target.dlc.id);
      if (result.ok) {
        toast.success(`${target.dlc.name} removed`);
        onChanged();
        onOpenChange(false);
      } else {
        toast.error(result.error);
      }
    } catch {
      toast.error('The DLC could not be removed. Try again.');
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form action={submit} className="space-y-4">
          {target.kind === 'base' ? null : (
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_7rem]">
              <Field
                id="name"
                label="Name"
                placeholder="Shadow of the Erdtree"
                {...initial(target.kind === 'edit' ? target.dlc.name : undefined)}
              />
              <Field
                id="year"
                label="Year played"
                placeholder="2026"
                {...initial(target.kind === 'edit' ? target.dlc.year : undefined)}
              />
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="hours"
              label="Hours"
              placeholder="23.5"
              {...initial(hoursText(figures?.hoursTenths ?? null))}
            />
            <Field
              id="priceDollars"
              label="Price paid"
              placeholder="39.99"
              {...initial(dollars(figures?.priceCents ?? null))}
            />
            <Field
              id="achievementsUnlocked"
              label="Trophies earned"
              placeholder="10"
              {...initial(figures?.achievementsUnlocked ?? undefined)}
            />
            <Field
              id="achievementsTotal"
              label="Trophies total"
              placeholder="12"
              {...initial(figures?.achievementsTotal ?? undefined)}
            />
          </div>
          {error === null ? null : (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <DialogFooter className="justify-between sm:justify-between">
            {target.kind === 'edit' ? (
              <Button
                type="button"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                disabled={removing}
                onClick={() => setConfirmingRemove(true)}
              >
                Remove DLC
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
      {target.kind === 'edit' ? (
        <ConfirmDialog
          open={confirmingRemove}
          onOpenChange={setConfirmingRemove}
          title={`Remove ${target.dlc.name}?`}
          description="Its hours, price and trophies come off the game's totals. This cannot be undone."
          confirmLabel="Remove"
          destructive
          onConfirm={() => void remove()}
        />
      ) : null}
    </Dialog>
  );
}
