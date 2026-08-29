'use client';

import Image from 'next/image';
import { Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import { FilterBar, FilterField } from '@/components/ui/filter-bar';
import { FilterChip } from '@/components/ui/filter-chip';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/finance/empty-state';
import { useNavigate } from '@/lib/use-navigate';
import { cn } from '@/lib/utils';
import { episodesWatched, formatRuntime, minutesWatched, sumMinutes } from '@/server/anime/runtime';
import { ANIME_STATUSES, STATUS_LABELS, type AnimeStatus } from '@/server/anime/taxonomy';
import type { Anime } from '@/server/db/anime/anime';

/**
 * The library.
 *
 * M1's version: the cover wall, the status chips, and search. Filtering is
 * entirely client-side for the reason the Games library gives — every filter
 * here is a pure re-render of data already loaded, and a round trip to hide a
 * card would be latency for nothing.
 *
 * Deliberately NOT a copy of `features/games/library/library-view.tsx`. It
 * reads the same primitives and follows the same layout contract, but the two
 * are separate files whose constraints differ: anime has no platform, no
 * ownership, no price, and its second dimension is episode progress rather than
 * hours played.
 */
export function AnimeLibraryView({ anime }: { readonly anime: readonly Anime[] }): React.ReactElement {
  const { navigate, pending: opening } = useNavigate();
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [status, setStatus] = useState<AnimeStatus | 'all'>('all');
  const [search, setSearch] = useState('');

  function open(row: Anime): void {
    setOpeningId(row.id);
    navigate(`/anime/${row.id}`);
  }

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return anime.filter((row) => {
      if (status !== 'all' && row.status !== status) return false;
      if (needle === '') return true;
      return (
        row.titleRomaji.toLowerCase().includes(needle) ||
        (row.titleEnglish ?? '').toLowerCase().includes(needle) ||
        (row.studio ?? '').toLowerCase().includes(needle)
      );
    });
  }, [anime, status, search]);

  const counts = useMemo(() => {
    const byStatus = new Map<AnimeStatus, number>();
    for (const row of anime) byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
    return byStatus;
  }, [anime]);

  // Computed here, never stored — and `null` for a show with no known episode
  // length, so it is skipped rather than counted as zero.
  const totalTime = useMemo(
    () => sumMinutes(anime.map((row) => minutesWatched(row.progress, row.repeatCount, row.episodes, row.durationMinutes))),
    [anime],
  );

  const filtered = status !== 'all' || search.trim() !== '';

  return (
    <div className="space-y-8">
      <PageHeader
        title="Anime"
        meta={
          <>
            <span>
              {filtered ? `${visible.length} of ${anime.length}` : `${anime.length}`}
              {anime.length === 1 ? ' show' : ' shows'}
            </span>
            {/* Labelled an estimate wherever it appears: AniList's duration is
                a per-show average, not a measurement of what was watched. */}
            {totalTime === null ? null : <span>· ≈{formatRuntime(totalTime)} watched</span>}
          </>
        }
      />

      <FilterBar>
        <FilterField label="Search">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search title or studio"
            aria-label="Search anime"
            className="w-64"
          />
        </FilterField>

        <div className="flex flex-wrap gap-2">
          {ANIME_STATUSES.filter((value) => (counts.get(value) ?? 0) > 0).map((value) => (
            <FilterChip
              key={value}
              label={STATUS_LABELS[value]}
              count={counts.get(value) ?? 0}
              active={status === value}
              onClick={() => setStatus(status === value ? 'all' : value)}
            />
          ))}
        </div>
      </FilterBar>

      {anime.length === 0 ? (
        <EmptyState>
          Nothing here yet. Sync from AniList in Settings to fill your library.
        </EmptyState>
      ) : visible.length === 0 ? (
        <EmptyState>No anime matches this filter.</EmptyState>
      ) : (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-6">
          {visible.map((row) => (
            <li key={row.id}>
              <AnimeCard row={row} opening={opening && openingId === row.id} onOpen={open} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One cover.
 *
 * The accessible name is an explicit `aria-label` carrying title, status and
 * progress, because the visible text is a title and a fraction sitting in
 * separate elements — and an accessible name computed from child nodes joins
 * them TRIMMED, producing "Frieren12 / 28". The visible title stays a prefix of
 * the label (WCAG 2.5.3).
 */
function AnimeCard({
  row,
  opening,
  onOpen,
}: {
  readonly row: Anime;
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
      }`}
      className="hover:ring-ring focus-visible:ring-ring group block w-full text-left focus-visible:ring-2 focus-visible:outline-none hover:ring-2 rounded-md overflow-hidden"
    >
      <span className="bg-muted relative block aspect-[3/4] w-full overflow-hidden rounded-md">
        {row.coverUrl === null ? (
          <span className="text-muted-foreground/50 flex h-full items-center justify-center text-2xl font-semibold" aria-hidden>
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

      <span className="mt-1.5 block truncate text-sm" aria-hidden>
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
