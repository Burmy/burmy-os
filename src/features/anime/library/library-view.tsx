'use client';

import Link from 'next/link';
import { ArrowRight, LayoutGrid, Plus, Table2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/finance/empty-state';
import { FilterBar, FilterField } from '@/components/ui/filter-bar';
import { FilterChip } from '@/components/ui/filter-chip';
import { FilterSelect } from '@/components/ui/filter-select';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SegmentedToggle } from '@/components/ui/segmented-toggle';
import { toast } from '@/components/ui/toast';
import { addAnimeToSeriesAction } from '@/features/anime/anime-actions';
import { useNavigate } from '@/lib/use-navigate';
import { formatRuntime, minutesWatched, sumMinutes } from '@/server/anime/runtime';
import { ANIME_STATUSES, STATUS_LABELS, type AnimeStatus } from '@/server/anime/taxonomy';
import type { Anime, AnimeSeriesRow } from '@/server/db/anime/anime';
import { AnimeCard } from './anime-card';
import { AnimeDialog } from './anime-dialog';
import { AnimeTable } from './anime-table';
import { BulkSeriesBar } from './bulk-series-bar';

type View = 'gallery' | 'table';

/** `'all'` and `'none'` are not series ids, so they cannot collide with one. */
const ALL_SERIES = 'all';
const NO_SERIES = 'none';

/**
 * The library.
 *
 * FILTERING IS ENTIRELY CLIENT-SIDE, for the reason the Games library gives:
 * every filter here is a pure re-render of data already loaded, and a round
 * trip to hide a card would be latency for nothing. That is also why there is
 * no `useNavigate` on the filters — nothing pushes a query string, so there is
 * no same-route navigation to report a pending state for. `useNavigate` IS
 * used for opening a show, which is a real route change.
 *
 * Deliberately NOT a copy of `features/games/library/library-view.tsx`. It
 * reads the same primitives and follows the same layout contract, but the two
 * are separate files whose constraints differ: anime has no platform, no
 * ownership and no price, its second dimension is episode progress rather than
 * hours played, and its grouping (a series) lives in a different table than
 * Games' (a collection row).
 */
export function AnimeLibraryView({
  anime,
  series,
}: {
  readonly anime: readonly Anime[];
  readonly series: readonly AnimeSeriesRow[];
}): React.ReactElement {
  const { navigate, pending: opening } = useNavigate();
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [view, setView] = useState<View>('gallery');
  const [status, setStatus] = useState<AnimeStatus | 'all'>('all');
  const [seriesFilter, setSeriesFilter] = useState<string>(ALL_SERIES);
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState(false);

  function open(row: Anime): void {
    setOpeningId(row.id);
    navigate(`/anime/${row.id}`);
  }

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return anime.filter((row) => {
      if (status !== 'all' && row.status !== status) return false;
      if (seriesFilter === NO_SERIES && row.seriesId !== null) return false;
      if (seriesFilter !== ALL_SERIES && seriesFilter !== NO_SERIES && row.seriesId !== seriesFilter) return false;
      if (needle === '') return true;
      return (
        row.titleRomaji.toLowerCase().includes(needle) ||
        (row.titleEnglish ?? '').toLowerCase().includes(needle) ||
        (row.studio ?? '').toLowerCase().includes(needle)
      );
    });
  }, [anime, status, seriesFilter, search]);

  const seriesById = useMemo(
    () => new Map(series.map((row) => [row.id, row.title])),
    [series],
  );

  const counts = useMemo(() => {
    const byStatus = new Map<AnimeStatus, number>();
    for (const row of anime) byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
    return byStatus;
  }, [anime]);

  // Computed here, never stored — and `null` for a show with no known episode
  // length, so it is skipped rather than counted as zero.
  const totalTime = useMemo(
    () =>
      sumMinutes(
        visible.map((row) => minutesWatched(row.progress, row.repeatCount, row.episodes, row.durationMinutes)),
      ),
    [visible],
  );

  const filtered = status !== 'all' || seriesFilter !== ALL_SERIES || search.trim() !== '';

  // The selection is kept as ids rather than rows, and narrowed to what is
  // actually on screen: filtering away a selected row and then bulk-filing
  // would move something the owner can no longer see.
  const selectedVisible = visible.filter((row) => selectedIds.has(row.id));

  function toggleSelected(id: string, selected: boolean): void {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (selected) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAll(selected: boolean): void {
    setSelectedIds(selected ? new Set(visible.map((row) => row.id)) : new Set());
  }

  async function addSelectedToSeries(seriesId: string): Promise<void> {
    const ids = selectedVisible.map((row) => row.id);
    if (ids.length === 0) return;

    try {
      const result = await addAnimeToSeriesAction(seriesId, ids);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const name = series.find((row) => row.id === seriesId)?.title ?? 'the series';
      toast.success(`${ids.length} show${ids.length === 1 ? '' : 's'} added to ${name}`);
      setSelectedIds(new Set());
    } catch {
      toast.error('That did not save. Nothing was changed.');
    }
  }

  return (
    <div className="min-w-0 space-y-8">
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
            {series.length === 0 ? null : (
              <span>
                · {series.length} series
              </span>
            )}
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="size-4" aria-hidden />
              Add show
            </Button>
            <SegmentedToggle
              value={view}
              onChange={setView}
              options={[
                { value: 'gallery', label: 'Gallery view', icon: <LayoutGrid className="size-4" /> },
                { value: 'table', label: 'Table view', icon: <Table2 className="size-4" /> },
              ]}
            />
          </div>
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

        {/* `FilterSelect` brings its own `FilterField` wrapper and label, so
            it is NOT nested inside another one — doing that would render the
            word "Series" twice, once as the field label and once as the
            select's own. */}
        {series.length === 0 ? null : (
          <FilterSelect
            label="Series"
            value={seriesFilter}
            onChange={setSeriesFilter}
            width="w-52"
            options={[
              [ALL_SERIES, 'All series'],
              [NO_SERIES, 'Not in a series'],
              ...series.map((row) => [row.id, row.title] as const),
            ]}
          />
        )}

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

      {/* Once the filter has narrowed to ONE series, offer its page. Without
          this the series filter is a dead end: it can show you the six seasons
          of a franchise and gives you no way to reach the franchise itself,
          where the totals and the "Add shows" panel live. */}
      {seriesFilter !== ALL_SERIES && seriesFilter !== NO_SERIES && seriesById.has(seriesFilter) ? (
        <Link
          href={`/anime/series/${seriesFilter}`}
          className="text-muted-foreground hover:text-foreground -mt-4 inline-flex items-center gap-1 text-sm underline-offset-2 hover:underline"
        >
          Open {seriesById.get(seriesFilter)}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      ) : null}

      {/* Only in the table view: the gallery has no checkboxes, so a bar
          offering to act on a selection that cannot be made there would be a
          control with nothing behind it. */}
      {view === 'table' && selectedVisible.length > 0 ? (
        <BulkSeriesBar
          selectedCount={selectedVisible.length}
          series={series.map((row) => ({ id: row.id, title: row.title }))}
          onClear={() => setSelectedIds(new Set())}
          onAdd={addSelectedToSeries}
        />
      ) : null}

      {anime.length === 0 ? (
        <EmptyState>
          Nothing here yet. Sync from AniList in Settings, or add a show by hand.
        </EmptyState>
      ) : visible.length === 0 ? (
        <EmptyState>No anime matches this filter.</EmptyState>
      ) : view === 'gallery' ? (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-6">
          {visible.map((row) => (
            <li key={row.id}>
              <AnimeCard
                row={row}
                seriesTitle={row.seriesId === null ? null : (seriesById.get(row.seriesId) ?? null)}
                opening={opening && openingId === row.id}
                onOpen={open}
              />
            </li>
          ))}
        </ul>
      ) : (
        // `min-w-0` here as well as on the page wrapper: every flex/grid
        // boundary defaults to `min-width: auto` independently, and the table
        // is exactly the wide descendant that otherwise pushes the whole chain
        // past the viewport instead of scrolling inside its own container.
        <div className="min-w-0">
          <AnimeTable
            rows={visible}
            seriesById={seriesById}
            selectedIds={selectedIds}
            openingId={opening ? openingId : null}
            onOpen={open}
            onToggleSelected={toggleSelected}
            onToggleAll={toggleAll}
          />
        </div>
      )}

      <AnimeDialog open={adding} onOpenChange={setAdding} />
    </div>
  );
}
