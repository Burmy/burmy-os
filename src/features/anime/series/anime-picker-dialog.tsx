'use client';

import { PickerDialog, type PickableItem } from '@/components/ui/picker-dialog';

/**
 * The Anime-worded face of `PickerDialog`.
 *
 * The dialog is a generic UI primitive (`src/components/ui/picker-dialog.tsx`);
 * this wrapper supplies the words that make it a SHOW picker. Games has its
 * own equivalent wrapper — the two modules share the primitive and never
 * import each other, which is exactly the line CLAUDE.md draws.
 *
 * `subtitle` here carries the airing season ("Fall 2023"), the thing that
 * tells "Season 2" apart from "Season 2" in a franchise with several.
 */
export type PickableAnime = PickableItem;

export function AnimePickerDialog(
  props: Omit<React.ComponentProps<typeof PickerDialog>, 'items' | 'searchLabel' | 'searchPlaceholder'> & {
    readonly shows: readonly PickableAnime[];
  },
): React.ReactElement {
  const { shows, emptyMessage = 'No shows match.', ...rest } = props;
  return (
    <PickerDialog
      {...rest}
      items={shows}
      emptyMessage={emptyMessage}
      searchLabel="Search shows"
      searchPlaceholder="Search your library"
    />
  );
}
