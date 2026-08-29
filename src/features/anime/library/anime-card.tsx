'use client';

import Image from 'next/image';
import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { episodesWatched } from '@/server/anime/runtime';
import { STATUS_LABELS } from '@/server/anime/taxonomy';
import type { Anime } from '@/server/db/anime/anime';

/**
 * One cover in the gallery.
 *
 * PORTRAIT 2:3 — the ratio AniList serves key art in. The Games card is 3:4
 * because a game box is; forcing anime art into that shape crops or
 * letterboxes every single cover.
 *
 * The accessible name is an explicit `aria-label` carrying title, status and
 * progress, because the visible text is a title and a fraction in separate
 * elements, and a computed name joins child nodes TRIMMED — "Frieren12 / 28",
 * which reads wrong and cannot be queried for. The visible title stays a
 * prefix of the label (WCAG 2.5.3). See CLAUDE.md.
 */
export function AnimeCard({
  row,
  seriesTitle,
  opening,
  onOpen,
}: {
  readonly row: Anime;
  /** The franchise this season belongs to, or `null`. Plain text, not a link — see below. */
  readonly seriesTitle: string | null;
  readonly opening: boolean;
  readonly onOpen: (row: Anime) => void;
}): React.ReactElement {
  const watched = episodesWatched(row.progress, row.repeatCount, row.episodes);
  const progressLabel = row.episodes === null ? `${row.progress} eps` : `${row.progress} / ${row.episodes}`;

  return (
    <button
      type="button"
      onClick={() => onOpen(row)}
      aria-busy={opening || undefined}
      aria-label={`${row.titleEnglish ?? row.titleRomaji} — ${STATUS_LABELS[row.status]}, ${progressLabel}${
        row.repeatCount > 0 ? `, rewatched ${row.repeatCount}x` : ''
      }${seriesTitle === null ? '' : `, part of ${seriesTitle}`}`}
      className="hover:ring-ring focus-visible:ring-ring group block w-full overflow-hidden rounded-md text-left focus-visible:ring-2 focus-visible:outline-none hover:ring-2"
    >
      <span className="bg-muted relative block aspect-[2/3] w-full overflow-hidden rounded-md">
        {row.coverUrl === null ? (
          <span
            className="text-muted-foreground/50 flex h-full items-center justify-center text-2xl font-semibold"
            aria-hidden
          >
            {row.titleRomaji.trim().charAt(0).toUpperCase()}
          </span>
        ) : (
          <Image src={row.coverUrl} alt="" fill sizes="200px" className="object-cover" />
        )}

        {opening ? (
          <span className="bg-background/60 absolute inset-0 flex items-center justify-center" aria-hidden>
            <Loader2 className="size-5 animate-spin" />
          </span>
        ) : null}
      </span>

      {/* The franchise, ABOVE the title and in the quietest weight on the
          card. Three "Attack on Titan" covers in a row with nothing tying them
          together read as three unrelated shows, which is the exact problem
          series exist to solve — and the gallery was silent about it.

          PLAIN TEXT, not a link: this whole card is a `<button>`, and a link
          nested inside a button is invalid HTML that browsers resolve however
          they like. The table view carries the real link, and the Series
          filter reaches the same place. */}
      {seriesTitle === null ? null : (
        <span className="text-muted-foreground/80 mt-1.5 block truncate text-xs" aria-hidden>
          {seriesTitle}
        </span>
      )}

      <span className={cn('block truncate text-sm', seriesTitle === null && 'mt-1.5')} aria-hidden>
        {row.titleEnglish ?? row.titleRomaji}
      </span>
      <span
        className={cn('text-muted-foreground tabular block text-xs', row.status === 'dropped' && 'line-through')}
        aria-hidden
      >
        {progressLabel}
        {row.repeatCount > 0 ? ` · ×${row.repeatCount + 1}` : ''}
        {watched > row.progress ? ` · ${watched} total` : ''}
      </span>
    </button>
  );
}
