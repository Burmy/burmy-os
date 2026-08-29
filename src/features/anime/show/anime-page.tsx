'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PageHeader } from '@/components/ui/page-header';
import { toast } from '@/components/ui/toast';
import type { ActionResult } from '@/features/anime/action-result';
import {
  type AnimeFieldKey,
  createSeriesForAnimeAction,
  deleteAnimeAction,
  setAnimeSeriesAction,
  updateAnimeFieldAction,
} from '@/features/anime/anime-actions';
import { InlineEditField } from '@/components/ui/inline-edit-row';
import type { PickableAnime } from '@/features/anime/series/anime-picker-dialog';
import { WatchLogList } from '@/features/anime/log/watch-log-list';
import { formatAiring } from '@/server/anime/taxonomy';
import type { Anime } from '@/server/db/anime/anime';
import type { WatchLogEntry } from '@/server/db/anime/watch-log';
import { AnimeDetails } from './anime-details';
import { AnimeSummaryPanel } from './anime-summary-panel';

/**
 * The full per-show page.
 *
 * Every field saves itself the instant it is committed — click a value, it
 * becomes a real control, blur or change calls `updateAnimeFieldAction` (one
 * generic action, validated per field by an exhaustive switch), and the page
 * re-renders with the fresh `anime` prop Next hands it after
 * `revalidatePath`. There is deliberately NO `useState(anime.field)` anywhere
 * in this file for a value an action can change: only pure UI state (is a
 * delete confirmation open) lives here. The whole-page Edit/Save/Cancel toggle
 * the Games page started with was tried and abandoned — changing one field
 * should only ever be editing that field.
 */
export function AnimePage({
  anime,
  series,
  seriesOptions,
  history,
}: {
  readonly anime: Anime;
  readonly series: { readonly id: string; readonly title: string } | null;
  /** Every series in the library, for the "Part of" picker. */
  readonly seriesOptions: readonly PickableAnime[];
  /** This show's own watch-log entries, newest first. Empty is a normal state. */
  readonly history: readonly WatchLogEntry[];
}): React.ReactElement {
  const router = useRouter();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deletePending, setDeletePending] = useState(false);

  function saveField(field: AnimeFieldKey, value: string): Promise<ActionResult> {
    return updateAnimeFieldAction(anime.id, field, value);
  }

  async function remove(): Promise<void> {
    setDeletePending(true);
    // try/catch/finally, never a bare await: a Server Action that REJECTS
    // skips every line after it, and this dialog's confirm button would stay
    // disabled with no error and no way back but a reload.
    try {
      const result = await deleteAnimeAction(anime.id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(`${anime.titleRomaji} removed`);
      router.push('/anime/library');
    } catch {
      toast.error('That did not delete. Nothing was changed.');
    } finally {
      setDeletePending(false);
    }
  }

  const airing = formatAiring(anime.season, anime.seasonYear);

  return (
    <div className="min-w-0">
      <Link href="/anime/library" className="text-muted-foreground hover:text-foreground text-sm">
        ← Anime
      </Link>

      <PageHeader
        title={anime.titleRomaji}
        className="mt-2"
        meta={airing === null ? null : <span>{airing}</span>}
        actions={
          <Button type="button" variant="ghost" onClick={() => setConfirmingDelete(true)} disabled={deletePending}>
            <Trash2 className="size-4" />
            Remove
          </Button>
        }
      />

      {/* `min-w-0` on the grid AND on the detail column. Every flex/grid
          boundary defaults to `min-width: auto` independently, so a long
          synopsis or genre list pushes the whole chain past the viewport
          unless each one overrides it — fixing only the nearest wrapper is
          documented as insufficient. */}
      <div className="mt-6 grid min-w-0 gap-8 sm:grid-cols-[260px_1fr]">
        <AnimeSummaryPanel
          coverUrl={anime.coverUrl}
          title={anime.titleRomaji}
          status={anime.status}
          progress={anime.progress}
          episodes={anime.episodes}
          repeatCount={anime.repeatCount}
          durationMinutes={anime.durationMinutes}
          onSaveField={saveField}
        />

        <div className="min-w-0 space-y-4">
          <InlineEditField
            label="Title"
            value={anime.titleRomaji}
            onSave={(value) => saveField('titleRomaji', value)}
          />

          <AnimeDetails
            titleEnglish={anime.titleEnglish}
            format={anime.format}
            episodes={anime.episodes}
            durationMinutes={anime.durationMinutes}
            season={anime.season}
            seasonYear={anime.seasonYear}
            studio={anime.studio}
            genre={anime.genre}
            source={anime.source}
            synopsis={anime.synopsis}
            notes={anime.notes}
            startedAt={anime.startedAt}
            completedAt={anime.completedAt}
            series={series}
            seriesOptions={seriesOptions}
            onSaveField={saveField}
            onSaveSeries={(seriesId) => setAnimeSeriesAction(anime.id, seriesId)}
            onCreateSeries={() => createSeriesForAnimeAction(anime.id)}
          />
        </div>
      </div>

      {/* Shown only when there IS history. An empty section on every
          hand-added show, and on every show watched before AniList's activity
          feed reaches, would be a permanent blank panel explaining nothing —
          the Log tab is where the feed's limits are stated once. */}
      {history.length === 0 ? null : (
        <div className="mt-8 min-w-0">
          <h2 className="text-muted-foreground mb-2 text-xs font-medium">History</h2>
          {/* `showTitles={false}` — the title is already the page heading. */}
          <WatchLogList entries={history} showTitles={false} />
        </div>
      )}

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={`Remove "${anime.titleRomaji}"?`}
        description="This deletes the entry and its watch history from your library. This can't be undone."
        confirmLabel="Remove"
        destructive
        onConfirm={remove}
      />
    </div>
  );
}
