'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InlineEditField } from '@/components/ui/inline-edit-row';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import type { ActionResult } from '@/features/games/action-result';
import {
  createGameDlcAction,
  deleteGameDlcAction,
  type DlcFieldKey,
  updateGameDlcFieldAction,
} from '@/features/games/dlc-actions';
import { type GameDlcRow, gameTotals, type Totalable } from '@/server/games/dlc';
import { formatHours, hours } from '@/server/games/hours';

/**
 * The game's DLC rows — one compact line per expansion, every cell
 * click-to-edit, an "Add DLC" form that needs only a name and a year, and a
 * totals line (base + every row) underneath.
 *
 * DLC is ADDITIVE (`src/server/games/dlc.ts`): nothing here has to add up to
 * anything, so there is no "unattributed" line and no validation across rows
 * — each cell saves itself exactly like the rest of the panel. The group is
 * never rendered for a collection member (the panel decides that; the DAL
 * refuses the insert anyway — see `DlcOnCollectionMemberError`).
 */
export function DlcGroup({
  gameId,
  dlc,
  base,
  onChanged,
}: {
  readonly gameId: string;
  readonly dlc: readonly GameDlcRow[];
  /** The game's own base figures, for the totals line. */
  readonly base: Totalable;
  /** After any successful write, so the panel re-fetches its copy of the game. */
  readonly onChanged: () => void;
}): React.ReactElement {
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<GameDlcRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function add(formData: FormData): Promise<void> {
    // try/catch/finally, not a bare await: a rejecting action would otherwise
    // leave the form disabled with no error shown.
    setSaving(true);
    try {
      const result = await createGameDlcAction(gameId, formData);
      if (result.ok) {
        setAdding(false);
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

  async function saveCell(dlcId: string, field: DlcFieldKey, value: string): Promise<ActionResult> {
    const result = await updateGameDlcFieldAction(dlcId, field, value);
    if (result.ok) onChanged();
    return result;
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

  return (
    <section>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-muted-foreground text-xs font-medium">DLC</h3>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)} disabled={adding}>
          <Plus className="size-3.5" aria-hidden />
          Add DLC
        </Button>
      </div>

      {dlc.length === 0 ? null : (
        <ul className="divide-y">
          {dlc.map((row) => (
            // The name takes the full first line; the figures sit on a second
            // line as fixed-width cells that never shrink — a `flex-1` name
            // beside them starved every figure down to "2…" at 520px.
            <li key={row.id} className="py-1.5">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1 font-medium">
                  <InlineEditField
                    hideLabel
                    label={`${row.name}: name`}
                    value={row.name}
                    onSave={(value) => saveCell(row.id, 'name', value)}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${row.name}`}
                  className="text-muted-foreground size-7 shrink-0"
                  onClick={() => setRemoving(row)}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              </div>
              <div className="text-muted-foreground -mt-1 flex flex-wrap items-center gap-x-4 text-sm">
                <Cell label="Year">
                  <InlineEditField
                    hideLabel
                    label={`${row.name}: year`}
                    value={String(row.year)}
                    onSave={(value) => saveCell(row.id, 'year', value)}
                  />
                </Cell>
                <Cell label="Hours">
                  <InlineEditField
                    hideLabel
                    label={`${row.name}: hours`}
                    value={row.hoursTenths === null ? '' : String(row.hoursTenths / 10)}
                    displayValue={
                      row.hoursTenths === null ? undefined : formatHours(hours(row.hoursTenths))
                    }
                    placeholder="—"
                    onSave={(value) => saveCell(row.id, 'hours', value)}
                  />
                </Cell>
                <Cell label="Price">
                  <InlineEditField
                    hideLabel
                    label={`${row.name}: price`}
                    value={row.priceCents === null ? '' : (row.priceCents / 100).toFixed(2)}
                    displayValue={row.priceCents === null ? undefined : formatPrice(row.priceCents)}
                    placeholder="—"
                    onSave={(value) => saveCell(row.id, 'priceDollars', value)}
                  />
                </Cell>
                <Cell label="Trophies">
                  <InlineEditField
                    hideLabel
                    label={`${row.name}: trophies earned`}
                    value={
                      row.achievementsUnlocked === null ? '' : String(row.achievementsUnlocked)
                    }
                    placeholder="—"
                    onSave={(value) => saveCell(row.id, 'achievementsUnlocked', value)}
                  />
                  <span aria-hidden>/</span>
                  <InlineEditField
                    hideLabel
                    label={`${row.name}: trophies total`}
                    value={row.achievementsTotal === null ? '' : String(row.achievementsTotal)}
                    placeholder="—"
                    onSave={(value) => saveCell(row.id, 'achievementsTotal', value)}
                  />
                </Cell>
              </div>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <form action={add} className="flex flex-wrap items-center gap-2 py-2">
          <Input
            name="name"
            aria-label="Name"
            placeholder="Name"
            required
            autoFocus
            className="h-8 min-w-0 flex-1 basis-40"
          />
          <Input
            name="year"
            aria-label="Year"
            placeholder="Year played"
            inputMode="numeric"
            required
            className="h-8 w-28"
          />
          <Button type="submit" size="sm" disabled={saving}>
            Save DLC
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </form>
      ) : null}

      {dlc.length === 0 ? null : (
        <p className="text-muted-foreground mt-1 text-xs">{totalsLine(gameTotals(base, dlc))}</p>
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
    </section>
  );
}

/** A figure on a DLC row: a tiny caption and the editable value beside it, never shrunk. */
function Cell({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <span className="text-xs">{label}</span>
      <span className="text-foreground inline-flex items-center gap-0.5">{children}</span>
    </span>
  );
}

function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** `Total · 142h · $105.64 · 52/54 trophies`, with any figure nobody recorded left out. */
function totalsLine(totals: ReturnType<typeof gameTotals>): string {
  const parts: string[] = ['Total'];
  if (totals.hoursTenths !== null) parts.push(formatHours(hours(totals.hoursTenths)));
  if (totals.priceCents !== null) parts.push(formatPrice(totals.priceCents));
  if (totals.achievementsUnlocked !== null) {
    const total = totals.achievementsTotal === null ? '' : `/${totals.achievementsTotal}`;
    parts.push(`${totals.achievementsUnlocked}${total} trophies`);
  }
  return parts.join(' · ');
}
