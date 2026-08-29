'use client';

import { Loader2, X } from 'lucide-react';
import { useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import type { ActionResult } from '@/features/games/action-result';
import { ROW_CLASS } from '@/components/ui/inline-edit-row';
import { cn } from '@/lib/utils';
import { GamePickerDialog, type PickableGame } from './game-picker-dialog';

/**
 * The "Part of" row on a game's detail page.
 *
 * Replaces the `InlineEditSelect` this used to be. That control renders every
 * option in one list, so with 179 games the owner scrolled past 178 titles to
 * find one — see `GamePickerDialog` for why search is the whole point.
 *
 * Laid out to match `InlineEditRow`'s label/value grid exactly, so the field
 * still reads as one of the rows in that block rather than as a foreign
 * control that happens to sit among them.
 */
export function CollectionField({
  collection,
  options,
  onSave,
}: {
  readonly collection: { readonly id: string; readonly title: string } | null;
  readonly options: readonly PickableGame[];
  readonly onSave: (collectionId: string | null) => Promise<ActionResult>;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const labelId = useId();
  const valueId = useId();

  async function save(collectionId: string | null): Promise<void> {
    setPending(true);
    const result = await onSave(collectionId);
    setPending(false);
    if (!result.ok) toast.error(result.error);
  }

  return (
    <div className={cn(ROW_CLASS, 'items-center')}>
      <span className="text-muted-foreground" id={labelId}>
        Part of
      </span>
      <div className="flex min-w-0 items-center gap-2">
        {/* `aria-labelledby` pointing at the row label AND the button itself,
            rather than an `aria-label` that repeats the field name. The
            computed name comes out "Part of <collection>", the visible text
            stays exactly the value, and nothing has to duplicate a string
            that could then drift. See CLAUDE.md on accessible names being
            concatenated from trimmed child nodes. */}
        <Button
          id={valueId}
          aria-labelledby={`${labelId} ${valueId}`}
          variant="ghost"
          size="sm"
          onClick={() => setOpen(true)}
          disabled={pending}
          className="h-auto min-w-0 justify-start px-2 py-1 font-normal"
        >
          <span className="truncate">{collection?.title ?? <span className="text-muted-foreground">Not in a collection</span>}</span>
        </Button>

        {/* Only offered when there is something to clear. A permanently
            visible X next to an empty field is a control that does nothing
            most of the time it is on screen. */}
        {collection === null ? null : (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove from ${collection.title}`}
            onClick={() => void save(null)}
            disabled={pending}
            className="size-7 shrink-0"
          >
            <X className="size-3.5" aria-hidden />
          </Button>
        )}

        {pending ? <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" aria-hidden /> : null}
      </div>

      <GamePickerDialog
        open={open}
        onOpenChange={setOpen}
        title="Put this game in a collection"
        description="Pick the boxed set or bundle this title belongs to."
        games={options}
        {...(collection === null ? {} : { selectedIds: [collection.id] })}
        emptyMessage="No collection matches that search."
        onConfirm={(ids) => save(ids[0] ?? null)}
      />
    </div>
  );
}
