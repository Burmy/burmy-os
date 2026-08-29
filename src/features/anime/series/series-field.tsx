'use client';

import { Loader2, X } from 'lucide-react';
import { Plus } from 'lucide-react';
import { useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ROW_CLASS } from '@/components/ui/inline-edit-row';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import type { ActionResult } from '@/features/anime/action-result';
import { AnimePickerDialog, type PickableAnime } from './anime-picker-dialog';

/**
 * The "Part of" row on a show's detail page — one end of series membership.
 *
 * The other end is `SeriesMembersPanel` on the series page, and both drive the
 * same write (`setSeriesForAnime`). Having both is not redundancy: filing a
 * season you are looking at, and gathering the seasons of a franchise you are
 * looking at, are two different moments, and each is clumsy from the other's
 * screen.
 *
 * Laid out on `ROW_CLASS`, so it reads as one of the inline-edit rows around
 * it rather than a foreign control that happens to sit among them.
 *
 * DIFFERENT FROM GAMES' `CollectionField` IN THE ONE WAY THAT MATTERS: a
 * series is a row in its own table, so it can be CREATED here. A game's
 * collection is another game and always already exists; a franchise usually
 * does not exist until the moment the owner decides two seasons belong
 * together, and making them leave for a different screen to create it first
 * would be the whole friction.
 */
export function SeriesField({
  series,
  options,
  onSave,
  onCreate,
}: {
  readonly series: { readonly id: string; readonly title: string } | null;
  readonly options: readonly PickableAnime[];
  readonly onSave: (seriesId: string | null) => Promise<ActionResult>;
  /** Creates a new series from this show's own title and files it in. */
  readonly onCreate: () => Promise<ActionResult>;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const labelId = useId();
  const valueId = useId();

  async function run(work: () => Promise<ActionResult>): Promise<void> {
    setPending(true);
    // try/finally, not a bare await: a Server Action that REJECTS skips every
    // line after it, which is how the Games duplicates screen once left every
    // button disabled with no error and no way back but a reload.
    try {
      const result = await work();
      if (!result.ok) toast.error(result.error);
    } catch {
      toast.error('That did not save. Nothing was changed.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={cn(ROW_CLASS, 'items-center')}>
      <span className="text-muted-foreground" id={labelId}>
        Part of
      </span>
      {/* `flex-wrap`: this row can hold four things (the value, a clear X, a
          "New series" button and a spinner) where every other inline-edit row
          holds one. On a 390px viewport the label column takes 9rem and the
          rest does not fit on one line — without wrapping it pushed the page
          to 415px wide, measured. */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {/* `aria-labelledby` pointing at the row label AND the button itself,
            rather than an `aria-label` repeating the field name: the computed
            name comes out "Part of <series>", the visible text stays exactly
            the value, and no string is duplicated to drift. See CLAUDE.md on
            accessible names being concatenated from TRIMMED child nodes. */}
        <Button
          id={valueId}
          aria-labelledby={`${labelId} ${valueId}`}
          variant="ghost"
          size="sm"
          onClick={() => setOpen(true)}
          disabled={pending}
          className="h-auto min-w-0 justify-start px-2 py-1 font-normal"
        >
          <span className="truncate">
            {series?.title ?? <span className="text-muted-foreground">Not in a series</span>}
          </span>
        </Button>

        {/* Only offered when there is something to clear. A permanently
            visible X beside an empty field is a control that does nothing
            most of the time it is on screen. */}
        {series === null ? null : (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove from ${series.title}`}
            onClick={() => void run(() => onSave(null))}
            disabled={pending}
            className="size-7 shrink-0"
          >
            <X className="size-3.5" aria-hidden />
          </Button>
        )}

        {series === null ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void run(onCreate)}
            disabled={pending}
            className="h-7 shrink-0 px-2 text-xs font-normal"
          >
            <Plus className="size-3.5" aria-hidden />
            New series
          </Button>
        ) : null}

        {pending ? <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" aria-hidden /> : null}
      </div>

      <AnimePickerDialog
        open={open}
        onOpenChange={setOpen}
        title="Put this show in a series"
        description="Pick the franchise this season, film or OVA belongs to."
        shows={options}
        {...(series === null ? {} : { selectedIds: [series.id] })}
        emptyMessage="No series matches that search."
        onConfirm={(ids) => run(() => onSave(ids[0] ?? null))}
      />
    </div>
  );
}
