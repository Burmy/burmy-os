'use client';

import { Loader2, X } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { GamePickerDialog, type PickableGame } from '@/features/games/collections/game-picker-dialog';

/**
 * The bar that appears once rows are selected in the library's table view.
 *
 * Filing several titles into one set is the job the per-game "Part of" field
 * is worst at: three games meant three page loads and three searches for the
 * same collection. Here it is one search and one confirm.
 *
 * Only ONE bulk action for now — "Add to collection" — because that is the
 * one the owner asked for. Removing games in bulk was considered and left
 * out: deletion already exists per game behind a confirm dialog, and a bulk
 * delete is the one control in this app where a mis-click destroys several
 * rows at once. It can be added when there is a reason beyond symmetry.
 */
export function BulkCollectionBar({
  selectedCount,
  collections,
  onClear,
  onAdd,
}: {
  readonly selectedCount: number;
  /** Rows the selection could be filed into — computed by the caller from what is on screen. */
  readonly collections: readonly PickableGame[];
  readonly onClear: () => void;
  readonly onAdd: (collectionId: string) => Promise<void>;
}): React.ReactElement {
  const [picking, setPicking] = useState(false);
  const [pending, setPending] = useState(false);

  async function add(ids: readonly string[]): Promise<void> {
    const collectionId = ids[0];
    if (collectionId === undefined) return;
    setPending(true);
    await onAdd(collectionId);
    setPending(false);
  }

  return (
    <div
      role="status"
      className="bg-card sticky top-2 z-10 flex items-center justify-between gap-4 rounded-md border px-4 py-2 shadow-sm"
    >
      <span className="text-sm font-medium">
        {selectedCount} selected
      </span>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => setPicking(true)} disabled={pending || collections.length === 0}>
          {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
          Add to collection
        </Button>
        <Button variant="ghost" size="sm" onClick={onClear} disabled={pending}>
          <X className="size-3.5" aria-hidden />
          Clear
        </Button>
      </div>

      <GamePickerDialog
        open={picking}
        onOpenChange={setPicking}
        title={`Add ${selectedCount} game${selectedCount === 1 ? '' : 's'} to a collection`}
        description="Pick the set these titles belong to."
        games={collections}
        emptyMessage="No collection matches that search."
        onConfirm={add}
      />
    </div>
  );
}
