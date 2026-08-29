'use client';

import Image from 'next/image';
import { Tv } from 'lucide-react';

import { InlineEditField, InlineEditSelect, ROW_CLASS } from '@/components/ui/inline-edit-row';
import { StatusBadge } from '@/components/ui/status-badge';
import { cn } from '@/lib/utils';
import type { ActionResult } from '@/features/anime/action-result';
import { STATUS_TONES } from '@/features/anime/status-tone';
import type { AnimeFieldKey } from '@/features/anime/anime-actions';
import { episodesWatched, formatRuntime, minutesWatched, watchPercent } from '@/server/anime/runtime';
import { ANIME_STATUSES, STATUS_LABELS, type AnimeStatus } from '@/server/anime/taxonomy';

const STATUS_OPTIONS = ANIME_STATUSES.map((status) => ({ value: status, label: STATUS_LABELS[status] }));

/**
 * The show page's left column: cover art plus the facts a person checks at a
 * glance — where they are in it, how much of it they have actually watched,
 * and whether it is finished.
 *
 * PORTRAIT 2:3, not the 3:4 the Games panel uses. Anime key art is drawn at
 * the poster ratio AniList serves it in; forcing it into a game-box aspect
 * would letterbox or crop every single cover.
 *
 * Time watched is labelled an ESTIMATE wherever it appears. `duration` is an
 * average episode length AniList publishes, not a measurement of what the
 * owner watched — openings skipped, a recap episode, a double-length finale
 * all move the real number. Saying "≈" costs nothing and stops a derived
 * figure from being read as a record.
 */
export function AnimeSummaryPanel({
  coverUrl,
  title,
  status,
  progress,
  episodes,
  repeatCount,
  durationMinutes,
  onSaveField,
}: {
  readonly coverUrl: string | null;
  readonly title: string;
  readonly status: AnimeStatus;
  readonly progress: number;
  readonly episodes: number | null;
  readonly repeatCount: number;
  readonly durationMinutes: number | null;
  readonly onSaveField: (field: AnimeFieldKey, value: string) => Promise<ActionResult>;
}): React.ReactElement {
  const watched = episodesWatched(progress, repeatCount, episodes);
  const minutes = minutesWatched(progress, repeatCount, episodes, durationMinutes);
  const percent = watchPercent(progress, episodes);

  return (
    <div className="space-y-4 sm:sticky sm:top-6">
      <div className="bg-muted relative aspect-[2/3] w-full overflow-hidden rounded-md">
        {coverUrl === null || coverUrl === '' ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5" aria-hidden>
            <span className="text-muted-foreground/40 text-4xl font-semibold">
              {title.trim().charAt(0).toUpperCase()}
            </span>
            <Tv className="text-muted-foreground/25 size-5" />
          </div>
        ) : (
          <Image src={coverUrl} alt="" fill sizes="280px" className="object-cover" />
        )}
      </div>

      {/* A real progress bar, not a number alone. "12 / 24" and "12 / 1094"
          are the same two numbers and completely different situations, and a
          bar is the one rendering that shows that without being read. It is
          omitted entirely when the total is unknown — an airing show with no
          published episode count has no fraction to draw, and a full-width
          bar would claim one. */}
      {percent === null ? null : (
        <div>
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

      <div className="space-y-0.5">
        <div className={cn(ROW_CLASS, 'items-center')}>
          <span className="text-muted-foreground">Status</span>
          <span>
            <StatusBadge tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</StatusBadge>
          </span>
        </div>

        <InlineEditSelect
          label="Set status"
          value={status}
          displayValue={STATUS_LABELS[status]}
          options={STATUS_OPTIONS}
          onSave={(value) => onSaveField('status', value)}
        />

        <InlineEditField
          label="Progress"
          value={String(progress)}
          displayValue={episodes === null ? `${progress} eps` : `${progress} / ${episodes}`}
          onSave={(value) => onSaveField('progress', value)}
        />

        <InlineEditField
          label="Rewatches"
          value={String(repeatCount)}
          displayValue={repeatCount === 0 ? 'None' : `${repeatCount}×`}
          {...(repeatCount === 0 ? {} : { hint: `${watched} episodes watched in total` })}
          onSave={(value) => onSaveField('repeatCount', value)}
        />

        <div className={ROW_CLASS}>
          <span className="text-muted-foreground">Time watched</span>
          <span>
            {minutes === null ? (
              <span className="text-muted-foreground italic">Unknown</span>
            ) : (
              <>
                ≈{formatRuntime(minutes)}
                <span className="text-muted-foreground block text-xs">
                  Estimated from an average episode length, not measured.
                </span>
              </>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
