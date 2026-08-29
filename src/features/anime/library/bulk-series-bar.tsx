'use client';

import { Loader2, X } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { AnimePickerDialog, type PickableAnime } from '@/features/anime/series/anime-picker-dialog';

/**
 * The bar that appears once rows are selected in the library's table view.
 *
 * Filing several seasons into one franchise is the job the per-show "Part of"
 * field is worst at: six seasons meant six page loads and six searches for the
 * same series. Here it is one search and one confirm.
 *
 * ONE BULK ACTION, deliberately. Bulk delete was considered and left out for
 * the reason `BulkCollectionBar` records: removal already exists per show
 * behind a confirm dialog, and a bulk delete is the one control in this app
 * where a mis-click destroys several rows at once. Symmetry is not a reason.
 */
export function BulkSeriesBar({
  selectedCount,
  series,
  onClear,
  onAdd,
}: {
  readonly selectedCount: number;
  /** Every series in the library — the selection can be filed into any of them. */
  readonly series: readonly PickableAnime[];
  readonly onClear: () => void;
  readonly onAdd: (seriesId: string) => Promise<void>;
}): React.ReactElement {
  const [picking, setPicking] = useState(false);
  const [pending, setPending] = useState(false);

  async function add(ids: readonly string[]): Promise<void> {
    const seriesId = ids[0];
    if (seriesId === undefined) return;
    setPending(true);
    try {
      await onAdd(seriesId);
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      role="status"
      className="bg-card sticky top-2 z-10 flex items-center justify-between gap-4 rounded-md border px-4 py-2 shadow-sm"
    >
      <span className="text-sm font-medium">{selectedCount} selected</span>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => setPicking(true)} disabled={pending || series.length === 0}>
          {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
          Add to series
        </Button>
        <Button variant="ghost" size="sm" onClick={onClear} disabled={pending}>
          <X className="size-3.5" aria-hidden />
          Clear
        </Button>
      </div>

      <AnimePickerDialog
        open={picking}
        onOpenChange={setPicking}
        title={`Add ${selectedCount} show${selectedCount === 1 ? '' : 's'} to a series`}
        description="Pick the franchise these belong to. Anything already in another series moves into this one."
        shows={series}
        emptyMessage="No series matches that search. Create one from a show's own page first."
        onConfirm={add}
      />
    </div>
  );
}
