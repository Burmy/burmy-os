'use client';

import Link from 'next/link';
import { Loader2 } from 'lucide-react';

import { Checkbox } from '@/components/ui/checkbox';
import { StatusBadge } from '@/components/ui/status-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { STATUS_TONES } from '@/features/anime/status-tone';
import { episodesWatched, formatRuntime, minutesWatched } from '@/server/anime/runtime';
import { FORMAT_LABELS, STATUS_LABELS, formatAiring } from '@/server/anime/taxonomy';
import type { Anime } from '@/server/db/anime/anime';

/**
 * The table view — the same library, read as data rather than as art.
 *
 * It exists because the gallery answers "what have I watched" and this
 * answers "which of these did I actually finish, and when". It is also where
 * multi-select lives: filing six seasons into a franchise from the gallery
 * would mean clicking covers, which is the one interaction a cover wall is
 * worst at.
 *
 * The whole thing sits inside `Table`'s own `overflow-x-auto` wrapper, and the
 * callers give every flex/grid boundary above it `min-w-0` — a wide table with
 * neither is exactly what pushed `<body>` to 979px on a 390px viewport once
 * already.
 */
export function AnimeTable({
  rows,
  seriesById,
  selectedIds,
  openingId,
  onOpen,
  onToggleSelected,
  onToggleAll,
}: {
  readonly rows: readonly Anime[];
  /** Series id → title, for the Series column's link. */
  readonly seriesById: ReadonlyMap<string, string>;
  readonly selectedIds: ReadonlySet<string>;
  readonly openingId: string | null;
  readonly onOpen: (row: Anime) => void;
  readonly onToggleSelected: (id: string, selected: boolean) => void;
  readonly onToggleAll: (selected: boolean) => void;
}): React.ReactElement {
  const allSelected = rows.length > 0 && rows.every((row) => selectedIds.has(row.id));

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">
            <Checkbox
              aria-label={allSelected ? 'Clear selection' : 'Select every show shown'}
              checked={allSelected}
              onCheckedChange={(state) => onToggleAll(state === true)}
            />
          </TableHead>
          <TableHead>Title</TableHead>
          <TableHead>Series</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Format</TableHead>
          <TableHead>Aired</TableHead>
          <TableHead>Studio</TableHead>
          <TableHead className="text-right">Progress</TableHead>
          <TableHead className="text-right">Watched</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const watched = episodesWatched(row.progress, row.repeatCount, row.episodes);
          const minutes = minutesWatched(row.progress, row.repeatCount, row.episodes, row.durationMinutes);

          return (
            <TableRow key={row.id}>
              <TableCell>
                <Checkbox
                  aria-label={`Select ${row.titleRomaji}`}
                  checked={selectedIds.has(row.id)}
                  onCheckedChange={(state) => onToggleSelected(row.id, state === true)}
                />
              </TableCell>
              <TableCell className="max-w-[22rem]">
                <button
                  type="button"
                  onClick={() => onOpen(row)}
                  aria-busy={openingId === row.id || undefined}
                  className={cn(
                    'hover:text-foreground flex w-full min-w-0 items-center gap-2 text-left font-medium transition-colors',
                    row.status === 'dropped' && 'line-through',
                  )}
                >
                  <span className="truncate">{row.titleEnglish ?? row.titleRomaji}</span>
                  {openingId === row.id ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
                  ) : null}
                </button>
              </TableCell>
              {/* The one place in the library that LINKS to a series page.
                  The gallery card cannot: it is a `<button>`, and a link
                  inside a button is invalid HTML. */}
              <TableCell className="max-w-[12rem]">
                {row.seriesId === null || !seriesById.has(row.seriesId) ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <Link
                    href={`/anime/series/${row.seriesId}`}
                    className="text-muted-foreground hover:text-foreground block truncate underline-offset-2 transition-colors hover:underline"
                  >
                    {seriesById.get(row.seriesId)}
                  </Link>
                )}
              </TableCell>
              <TableCell>
                <StatusBadge tone={STATUS_TONES[row.status]}>{STATUS_LABELS[row.status]}</StatusBadge>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {row.format === null ? '—' : FORMAT_LABELS[row.format]}
              </TableCell>
              <TableCell className="text-muted-foreground whitespace-nowrap">
                {formatAiring(row.season, row.seasonYear) ?? '—'}
              </TableCell>
              <TableCell className="text-muted-foreground max-w-[14rem] truncate">{row.studio ?? '—'}</TableCell>
              <TableCell className="tabular text-right whitespace-nowrap">
                {row.episodes === null ? row.progress : `${row.progress} / ${row.episodes}`}
                {row.repeatCount > 0 ? ` ×${row.repeatCount + 1}` : ''}
              </TableCell>
              <TableCell className="tabular text-right whitespace-nowrap">
                {watched} ep{watched === 1 ? '' : 's'}
                {/* "≈" every time it appears: `duration` is an average AniList
                    publishes, not a measurement of what was watched. */}
                {minutes === null ? '' : ` · ≈${formatRuntime(minutes)}`}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
