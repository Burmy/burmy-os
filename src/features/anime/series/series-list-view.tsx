'use client';

import Image from 'next/image';
import { Loader2, Tv } from 'lucide-react';
import { useMemo, useState } from 'react';

import { EmptyState } from '@/components/finance/empty-state';
import { FilterBar, FilterField } from '@/components/ui/filter-bar';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { useNavigate } from '@/lib/use-navigate';
import { formatRuntime } from '@/server/anime/runtime';
import { seriesCover, seriesTotals } from '@/server/anime/series';
import type { SeriesWithMembers } from '@/server/db/anime/anime';

/**
 * Every franchise, in one place.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS TAB EXISTS.
 *
 * Series were reachable only sideways: a link in the library's table view, or
 * by picking one in the library's filter dropdown. Both require already knowing
 * the franchise is there. The owner asked for seasons to NEST under a series,
 * and a nesting nobody can browse is a data model, not a feature.
 *
 * A franchise is shown as ONE card with its member count, which is the nesting
 * made visible — the Library tab stays flat on purpose, because a season is
 * still a show you watched and the library's counts must never disagree with
 * the stats page.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every figure here is derived from members at render time by `seriesTotals`,
 * the same function the series page itself uses, so the list and the page can
 * never disagree.
 */
export function SeriesListView({ series }: { readonly series: readonly SeriesWithMembers[] }): React.ReactElement {
  const { navigate, pending } = useNavigate();
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const rows = useMemo(
    () =>
      series.map((entry) => ({
        ...entry,
        totals: seriesTotals(entry.members),
        cover: seriesCover(entry.series.coverUrl, entry.members),
      })),
    [series],
  );

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (needle === '') return rows;
    return rows.filter(
      (row) =>
        row.series.title.toLowerCase().includes(needle) ||
        // Searching a SEASON's name finds the franchise it belongs to, which is
        // how anyone actually looks for one — you remember "Final Season", not
        // the base title the grouping heuristic produced.
        row.members.some((member) => member.titleRomaji.toLowerCase().includes(needle)),
    );
  }, [rows, search]);

  const totalShows = rows.reduce((sum, row) => sum + row.totals.showCount, 0);

  function open(id: string): void {
    setOpeningId(id);
    navigate(`/anime/series/${id}`);
  }

  return (
    <div className="min-w-0 space-y-8">
      <PageHeader
        title="Series"
        meta={
          <>
            <span>
              {search.trim() === '' ? rows.length : `${visible.length} of ${rows.length}`}
              {rows.length === 1 ? ' series' : ' series'}
            </span>
            {totalShows === 0 ? null : <span>· {totalShows} shows grouped</span>}
          </>
        }
      />

      {rows.length === 0 ? null : (
        <FilterBar>
          <FilterField label="Search">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search series or a season in one"
              aria-label="Search series"
              className="w-72"
            />
          </FilterField>
        </FilterBar>
      )}

      {rows.length === 0 ? (
        <EmptyState>
          No series yet. Open a show and use &ldquo;Part of&rdquo; to start one, or approve a grouping the
          next time you sync from AniList.
        </EmptyState>
      ) : visible.length === 0 ? (
        <EmptyState>No series matches that search.</EmptyState>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((row) => (
            <li key={row.series.id}>
              <SeriesCard
                title={row.series.title}
                cover={row.cover}
                members={row.members.map((member) => member.titleRomaji)}
                totals={row.totals}
                opening={pending && openingId === row.series.id}
                onOpen={() => open(row.series.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SeriesCard({
  title,
  cover,
  members,
  totals,
  opening,
  onOpen,
}: {
  readonly title: string;
  readonly cover: string | null;
  readonly members: readonly string[];
  readonly totals: ReturnType<typeof seriesTotals>;
  readonly opening: boolean;
  readonly onOpen: () => void;
}): React.ReactElement {
  const span =
    totals.firstYear === null
      ? null
      : totals.lastYear === totals.firstYear
        ? String(totals.firstYear)
        : `${totals.firstYear}–${totals.lastYear}`;

  const summary = [
    `${totals.showCount} ${totals.showCount === 1 ? 'show' : 'shows'}`,
    `${totals.episodesWatched.toLocaleString()} eps`,
    // The "≈" is never dropped: this is an average episode length, not a
    // measurement of what was watched.
    totals.minutesWatched === null ? null : `≈${formatRuntime(totals.minutesWatched)}`,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-busy={opening || undefined}
      // Explicit, because the card's visible text is five sibling elements and
      // a computed name joins them each TRIMMED — "Attack on Titan2013–20173
      // shows". See CLAUDE.md.
      aria-label={`${title}${span === null ? '' : `, ${span}`} — ${summary}`}
      className="hover:bg-muted/40 hover:ring-ring focus-visible:ring-ring bg-card flex w-full min-w-0 gap-4 rounded-md p-4 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none hover:ring-2"
    >
      <span className="bg-muted relative h-24 w-16 shrink-0 overflow-hidden rounded-md">
        {cover === null ? (
          <span className="flex h-full flex-col items-center justify-center gap-1" aria-hidden>
            <span className="text-muted-foreground/40 text-lg font-semibold">
              {title.trim().charAt(0).toUpperCase()}
            </span>
            <Tv className="text-muted-foreground/25 size-3.5" />
          </span>
        ) : (
          <Image src={cover} alt="" fill sizes="64px" className="object-cover" />
        )}
        {opening ? (
          <span className="bg-background/60 absolute inset-0 flex items-center justify-center" aria-hidden>
            <Loader2 className="size-4 animate-spin" />
          </span>
        ) : null}
      </span>

      <span className="min-w-0 flex-1" aria-hidden>
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate font-medium">{title}</span>
          {span === null ? null : <span className="text-muted-foreground shrink-0 text-xs">{span}</span>}
        </span>
        <span className="text-muted-foreground tabular mt-0.5 block text-xs">{summary}</span>

        {/* The seasons themselves, which is the nesting made visible — a
            franchise card that only said "3 shows" would hide the one thing
            the owner is checking, namely WHICH three. Capped, because a
            long-running franchise would otherwise set the whole grid's row
            height. */}
        <span className="text-muted-foreground/80 mt-2 block space-y-0.5 text-xs">
          {members.slice(0, MEMBERS_SHOWN).map((member) => (
            <span key={member} className="block truncate">
              {member}
            </span>
          ))}
          {members.length > MEMBERS_SHOWN ? (
            <span className="block">+{members.length - MEMBERS_SHOWN} more</span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

/** Enough to recognise a franchise; few enough that one long series does not set every card's height. */
const MEMBERS_SHOWN = 3;
