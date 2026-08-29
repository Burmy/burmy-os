'use client';

import Image from 'next/image';
import { Tv } from 'lucide-react';

import { InlineEditSelect } from '@/components/ui/inline-edit-row';
import type { ActionResult } from '@/features/anime/action-result';
import type { AnimeFieldKey } from '@/features/anime/anime-actions';
import { watchPercent } from '@/server/anime/runtime';
import { ANIME_STATUSES, STATUS_LABELS, type AnimeStatus } from '@/server/anime/taxonomy';

const STATUS_OPTIONS = ANIME_STATUSES.map((status) => ({ value: status, label: STATUS_LABELS[status] }));

/**
 * The show page's left column: the cover, how far through it you are, and the
 * one field you change most often.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DELIBERATELY SHORT. It holds THREE things.
 *
 * It started out holding progress, rewatches and time watched too, and looking
 * at the running page settled it: a 9rem label column inside a 260px panel
 * leaves ~100px for the value, so "128 episodes watched in total" wrapped to
 * four lines and the time estimate's caption to five — while the detail column
 * beside it, twice as wide, ended halfway up the page. Those three fields moved
 * right, where they read on one line each.
 *
 * `ROW_CLASS`'s fixed label column is right for a wide column and wrong for a
 * narrow one. Games' panel gets away with it because its values are "PS5",
 * "Backlog", "22.1h" — short enough never to wrap.
 *
 * ONE STATUS ROW, NOT TWO. There was a read-only badge above an editable
 * select, which is the same fact stated twice with two different controls. The
 * badge's job is being scannable in a LIST; on a page about one show it is
 * decoration, and the editable row is the one that does something.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function AnimeSummaryPanel({
  coverUrl,
  title,
  status,
  progress,
  episodes,
  onSaveField,
}: {
  readonly coverUrl: string | null;
  readonly title: string;
  readonly status: AnimeStatus;
  readonly progress: number;
  readonly episodes: number | null;
  readonly onSaveField: (field: AnimeFieldKey, value: string) => Promise<ActionResult>;
}): React.ReactElement {
  const percent = watchPercent(progress, episodes);

  return (
    <div className="space-y-4 sm:sticky sm:top-6">
      {/* PORTRAIT 2:3 — the ratio AniList serves key art in. The Games card is
          3:4 because a game box is; forcing anime art into that shape crops or
          letterboxes every cover. */}
      <div className="bg-muted relative aspect-[2/3] w-full overflow-hidden rounded-md">
        {coverUrl === null || coverUrl === '' ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5" aria-hidden>
            <span className="text-muted-foreground/40 text-4xl font-semibold">
              {title.trim().charAt(0).toUpperCase()}
            </span>
            <Tv className="text-muted-foreground/25 size-5" />
          </div>
        ) : (
          <Image src={coverUrl} alt="" fill sizes="260px" className="object-cover" />
        )}
      </div>

      {/* A bar AND the fraction beside it. "12 / 24" and "12 / 1094" are the
          same two numbers and completely different situations, which only the
          bar shows without being read; the fraction is what you actually want
          to know. Omitted entirely when the total is unknown — an airing show
          with no published episode count has no fraction to draw, and a
          full-width bar would claim one. */}
      {percent === null ? null : (
        <div className="space-y-1.5">
          <div className="text-muted-foreground flex items-baseline justify-between text-xs">
            <span className="tabular">
              {progress} / {episodes}
            </span>
            <span className="tabular">{Math.round(percent)}%</span>
          </div>
          <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
            <div
              className="bg-primary h-full rounded-full transition-[width]"
              style={{ width: `${percent}%` }}
              role="progressbar"
              aria-label={`${progress} of ${episodes} episodes watched`}
              aria-valuenow={Math.round(percent)}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          </div>
        </div>
      )}

      <InlineEditSelect
        label="Status"
        value={status}
        displayValue={STATUS_LABELS[status]}
        options={STATUS_OPTIONS}
        onSave={(value) => onSaveField('status', value)}
      />
    </div>
  );
}
