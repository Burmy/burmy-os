'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Tv, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InlineEditField } from '@/components/ui/inline-edit-row';
import { PageHeader } from '@/components/ui/page-header';
import { StatCard } from '@/components/ui/stat-card';
import { StatCardGrid } from '@/components/ui/stat-card-grid';
import { toast } from '@/components/ui/toast';
import { deleteSeriesAction, updateSeriesFieldAction } from '@/features/anime/anime-actions';
import type { PickableAnime } from './anime-picker-dialog';
import { SeriesMembersPanel } from './series-members-panel';
import { formatRuntime } from '@/server/anime/runtime';
import { seriesCover, seriesTotals } from '@/server/anime/series';
import type { Anime } from '@/server/db/anime/anime';
import type { AnimeSeriesRow } from '@/server/db/anime/anime';

/**
 * A franchise page: what it contains, and what watching all of it added up to.
 *
 * EVERY FIGURE ON THIS PAGE IS DERIVED FROM THE MEMBERS AT READ TIME. A series
 * stores a name, an optional cover override, and the AniList parent id that
 * makes a re-sync resolve it — nothing else. That is the same invariant
 * Finance states as "never store a total", and here it is also what keeps the
 * counting rule trivial: `anime_series` is a different table from `anime`, so
 * nothing that counts shows can ever accidentally count a franchise.
 */
export function SeriesPage({
  series,
  members,
  candidates,
}: {
  readonly series: AnimeSeriesRow;
  readonly members: readonly Anime[];
  readonly candidates: readonly PickableAnime[];
}): React.ReactElement {
  const router = useRouter();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deletePending, setDeletePending] = useState(false);

  const totals = seriesTotals(members);
  const cover = seriesCover(series.coverUrl, members);

  const span =
    totals.firstYear === null
      ? null
      : totals.lastYear === totals.firstYear
        ? String(totals.firstYear)
        : `${totals.firstYear}–${totals.lastYear}`;

  async function remove(): Promise<void> {
    setDeletePending(true);
    try {
      const result = await deleteSeriesAction(series.id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      // Says what happened to the SHOWS, because "deleted" on its own reads
      // like they went with it — and they did not.
      toast.success(
        members.length === 0
          ? `${series.title} dissolved`
          : `${series.title} dissolved — its ${members.length} show${members.length === 1 ? '' : 's'} ${
              members.length === 1 ? 'is' : 'are'
            } now standalone`,
      );
      router.push('/anime/library');
    } catch {
      toast.error('That did not delete. Nothing was changed.');
    } finally {
      setDeletePending(false);
    }
  }

  return (
    <div className="min-w-0">
      <Link href="/anime/library" className="text-muted-foreground hover:text-foreground text-sm">
        ← Anime
      </Link>

      <PageHeader
        title={series.title}
        className="mt-2"
        meta={span === null ? null : <span>{span}</span>}
        actions={
          <Button type="button" variant="ghost" onClick={() => setConfirmingDelete(true)} disabled={deletePending}>
            <Trash2 className="size-4" />
            Dissolve
          </Button>
        }
      />

      <div className="mt-6 grid min-w-0 gap-8 sm:grid-cols-[200px_1fr]">
        <div className="min-w-0 space-y-4">
          <div className="bg-muted relative aspect-[2/3] w-full overflow-hidden rounded-md">
            {cover === null ? (
              <div className="flex h-full flex-col items-center justify-center gap-1.5" aria-hidden>
                <span className="text-muted-foreground/40 text-4xl font-semibold">
                  {series.title.trim().charAt(0).toUpperCase()}
                </span>
                <Tv className="text-muted-foreground/25 size-5" />
              </div>
            ) : (
              <Image src={cover} alt="" fill sizes="200px" className="object-cover" />
            )}
          </div>
          {/* Says where the art came from when it was not chosen, and now
              names the field that changes it — this used to point at a control
              the page did not have. */}
          {series.coverUrl === null && cover !== null ? (
            <p className="text-muted-foreground text-xs">
              Showing the earliest season&apos;s cover. Set a Cover URL to override it.
            </p>
          ) : null}
        </div>

        <div className="min-w-0 space-y-6">
          <div className="space-y-0.5">
            <InlineEditField
              label="Series name"
              value={series.title}
              onSave={(value) => updateSeriesFieldAction(series.id, 'title', value)}
            />

            {/* The cover OVERRIDE, which had a column and no way to set it.
                Deliberately last of the two and described by its own hint,
                because leaving it empty is the normal answer — the earliest
                season's art is right for almost every franchise, and this
                exists for the ones with key art belonging to no single
                season. */}
            <InlineEditField
              label="Cover URL"
              value={series.coverUrl ?? ''}
              {...(series.coverUrl === null
                ? {}
                : {
                    displayValue: 'Custom image',
                    hint: 'Overriding the earliest season\u2019s cover. Clear it to go back.',
                  })}
              placeholder="Using a season's cover"
              onSave={(value) => updateSeriesFieldAction(series.id, 'coverUrl', value)}
            />

            <InlineEditField
              label="Notes"
              value={series.notes ?? ''}
              multiline
              placeholder="Nothing yet"
              onSave={(value) => updateSeriesFieldAction(series.id, 'notes', value)}
            />
          </div>

          <StatCardGrid>
            <StatCard label="Shows" value={String(totals.showCount)} />
            <StatCard label="Episodes watched" value={totals.episodesWatched.toLocaleString()} />
            <StatCard
              label="Time watched"
              value={totals.minutesWatched === null ? '—' : `≈${formatRuntime(totals.minutesWatched)}`}
              {...(totals.minutesWatched === null
                ? { hint: 'No member has a known episode length.' }
                : { hint: 'Estimated from average episode lengths.' })}
            />
            <StatCard label="Aired" value={span ?? '—'} />
          </StatCardGrid>

          <div className="min-w-0">
            <SeriesMembersPanel
              seriesId={series.id}
              seriesTitle={series.title}
              members={members}
              candidates={candidates}
            />
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={`Dissolve "${series.title}"?`}
        // Stated plainly, because the word "delete" beside a page listing six
        // shows invites exactly the wrong assumption.
        description={
          members.length === 0
            ? 'This removes the series. Nothing else changes.'
            : `The ${members.length} show${members.length === 1 ? '' : 's'} inside will stay in your library as standalone entries. Only the grouping is removed.`
        }
        confirmLabel="Dissolve"
        destructive
        onConfirm={remove}
      />
    </div>
  );
}
