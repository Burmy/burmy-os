'use client';

import { InlineEditField, InlineEditSelect, ROW_CLASS } from '@/components/ui/inline-edit-row';
import type { ActionResult } from '@/features/anime/action-result';
import type { AnimeFieldKey } from '@/features/anime/anime-actions';
import { SeriesField } from '@/features/anime/series/series-field';
import type { PickableAnime } from '@/features/anime/series/anime-picker-dialog';
import { episodesWatched, formatRuntime, minutesWatched } from '@/server/anime/runtime';
import {
  ANIME_FORMATS,
  ANIME_SEASONS,
  ANIME_SOURCES,
  FORMAT_LABELS,
  SEASON_LABELS,
  SOURCE_LABELS,
  type AnimeFormat,
  type AnimeSeason,
  type AnimeSource,
} from '@/server/anime/taxonomy';

const FORMAT_OPTIONS = ANIME_FORMATS.map((format) => ({ value: format, label: FORMAT_LABELS[format] }));
const SEASON_OPTIONS = ANIME_SEASONS.map((season) => ({ value: season, label: SEASON_LABELS[season] }));
const SOURCE_OPTIONS = ANIME_SOURCES.map((source) => ({ value: source, label: SOURCE_LABELS[source] }));

/**
 * Everything about the show that is not progress: what it is, when it aired,
 * who made it, and where it sits in a franchise.
 *
 * TWO COLUMNS on a wide screen, for the reason `GameDetailsContent` records:
 * one full-width column drifts a label and its value to opposite ends of a
 * 1600px row, and the fix that actually worked was narrowing the rows rather
 * than capping the page. `min-w-0` on each column because a long studio name
 * or genre list is exactly the wide descendant that otherwise pushes the whole
 * flex chain past the viewport.
 *
 * Every field here is editable, including the ones a sync fills. That is the
 * opposite of the Games page, where Steam-owned fields render read-only — and
 * the difference is deliberate: AniList PROPOSES rather than applies, so an
 * owner edit is never silently overwritten, and there is nothing to protect
 * the field from. `planLinkedAnimeChanges` will offer the change again next
 * sync, and the owner can decline it again.
 */
export function AnimeDetails({
  titleEnglish,
  format,
  episodes,
  progress,
  repeatCount,
  durationMinutes,
  season,
  seasonYear,
  studio,
  genre,
  source,
  synopsis,
  notes,
  startedAt,
  completedAt,
  series,
  seriesOptions,
  onSaveField,
  onSaveSeries,
  onCreateSeries,
}: {
  readonly titleEnglish: string | null;
  readonly format: AnimeFormat | null;
  readonly episodes: number | null;
  readonly progress: number;
  readonly repeatCount: number;
  readonly durationMinutes: number | null;
  readonly season: AnimeSeason | null;
  readonly seasonYear: number | null;
  readonly studio: string | null;
  readonly genre: string | null;
  readonly source: AnimeSource | null;
  readonly synopsis: string | null;
  readonly notes: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly series: { readonly id: string; readonly title: string } | null;
  readonly seriesOptions: readonly PickableAnime[];
  readonly onSaveField: (field: AnimeFieldKey, value: string) => Promise<ActionResult>;
  readonly onSaveSeries: (seriesId: string | null) => Promise<ActionResult>;
  readonly onCreateSeries: () => Promise<ActionResult>;
}): React.ReactElement {
  // Both computed at render, never stored — `runtime.ts` is the only place
  // either conversion happens, the same containment rule `money.ts` holds.
  const watched = episodesWatched(progress, repeatCount, episodes);
  const minutes = minutesWatched(progress, repeatCount, episodes, durationMinutes);

  return (
    <div className="grid min-w-0 gap-x-8 gap-y-0.5 lg:grid-cols-2">
      <div className="min-w-0 space-y-0.5">
        {/* Progress, rewatches and time watched live HERE rather than in the
            summary panel beside the cover. They started there and the running
            page settled it: a 9rem label column inside a 260px panel wrapped
            "128 episodes watched in total" to four lines, while this column —
            twice as wide — ended halfway up the page. */}
        <InlineEditField
          label="Progress"
          value={String(progress)}
          displayValue={episodes === null ? `${progress} episodes` : `${progress} / ${episodes}`}
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
            {/* Always "≈", never a bare figure: `durationMinutes` is an average
                AniList publishes, not a measurement of what was watched. */}
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

        <InlineEditField
          label="English title"
          value={titleEnglish ?? ''}
          onSave={(value) => onSaveField('titleEnglish', value)}
        />

        <InlineEditSelect
          label="Format"
          value={format ?? ''}
          displayValue={format === null ? '' : FORMAT_LABELS[format]}
          options={FORMAT_OPTIONS}
          onSave={(value) => onSaveField('format', value)}
        />

        <InlineEditField
          label="Episodes"
          value={episodes === null ? '' : String(episodes)}
          placeholder="Unknown"
          onSave={(value) => onSaveField('episodes', value)}
        />

        <InlineEditField
          label="Episode length"
          value={durationMinutes === null ? '' : String(durationMinutes)}
          displayValue={durationMinutes === null ? undefined : `${durationMinutes} min`}
          placeholder="Unknown"
          onSave={(value) => onSaveField('durationMinutes', value)}
        />

        <SeriesField
          series={series}
          options={seriesOptions}
          onSave={onSaveSeries}
          onCreate={onCreateSeries}
        />
      </div>

      <div className="min-w-0 space-y-0.5">
        <InlineEditSelect
          label="Season"
          value={season ?? ''}
          displayValue={season === null ? '' : SEASON_LABELS[season]}
          options={SEASON_OPTIONS}
          onSave={(value) => onSaveField('season', value)}
        />

        <InlineEditField
          label="Year"
          value={seasonYear === null ? '' : String(seasonYear)}
          placeholder="Unknown"
          onSave={(value) => onSaveField('seasonYear', value)}
        />

        <InlineEditField label="Studio" value={studio ?? ''} onSave={(value) => onSaveField('studio', value)} />

        <InlineEditField
          label="Genres"
          value={genre ?? ''}
          onSave={(value) => onSaveField('genre', value)}
        />

        <InlineEditSelect
          label="Source"
          value={source ?? ''}
          displayValue={source === null ? '' : SOURCE_LABELS[source]}
          options={SOURCE_OPTIONS}
          onSave={(value) => onSaveField('source', value)}
        />
      </div>

      {/* Full width below both columns. Dates belong together, and a synopsis
          or a note is a paragraph — putting either in a 490px column makes it
          five words wide. */}
      <div className="min-w-0 space-y-0.5 lg:col-span-2">
        <InlineEditField
          label="Started"
          value={startedAt ?? ''}
          placeholder="Not recorded"
          onSave={(value) => onSaveField('startedAt', value)}
        />

        <InlineEditField
          label="Finished"
          value={completedAt ?? ''}
          placeholder="Not recorded"
          onSave={(value) => onSaveField('completedAt', value)}
        />

        <InlineEditField
          label="Notes"
          value={notes ?? ''}
          multiline
          placeholder="Nothing yet"
          onSave={(value) => onSaveField('notes', value)}
        />

        <InlineEditField
          label="Synopsis"
          value={synopsis ?? ''}
          multiline
          placeholder="Not recorded"
          onSave={(value) => onSaveField('synopsis', value)}
        />
      </div>
    </div>
  );
}
