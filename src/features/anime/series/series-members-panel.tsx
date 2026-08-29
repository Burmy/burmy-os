'use client';

import Image from 'next/image';
import Link from 'next/link';
import { Loader2, Plus, X } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { toast } from '@/components/ui/toast';
import { addAnimeToSeriesAction, setAnimeSeriesAction } from '@/features/anime/anime-actions';
import { episodesWatched, formatRuntime, minutesWatched } from '@/server/anime/runtime';
import { STATUS_LABELS, formatAiring } from '@/server/anime/taxonomy';
import type { Anime } from '@/server/db/anime/anime';
import { STATUS_TONES } from '@/features/anime/status-tone';
import { AnimePickerDialog, type PickableAnime } from './anime-picker-dialog';

/**
 * The shows inside a series, editable from the series' own side.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY MEMBERSHIP IS EDITABLE FROM BOTH ENDS.
 *
 * The other control is `SeriesField` on a show's page, which is right when you
 * are looking at one season and know where it belongs. Assembling a franchise
 * is the opposite task — you are looking at the SERIES and know which seasons
 * go in it — and forcing that through the per-show field costs one page load
 * per season plus remembering the franchise's exact name each time.
 *
 * Both directions write the same column through the same action, so neither is
 * a shortcut around anything.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Each row shows what belongs to the individual season: its art, when it
 * aired, its status and its own episode count. Nothing is rolled up per row —
 * the series' totals live in the header above, where they describe the whole
 * franchise once instead of being repeated, wrongly, on every line.
 */
export function SeriesMembersPanel({
  seriesId,
  seriesTitle,
  members,
  candidates,
}: {
  readonly seriesId: string;
  readonly seriesTitle: string;
  readonly members: readonly Anime[];
  /** Shows that could be added — everything not already in a DIFFERENT series. See `listSeriesCandidates`. */
  readonly candidates: readonly PickableAnime[];
}): React.ReactElement {
  const [picking, setPicking] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const memberIds = members.map((member) => member.id);

  async function add(ids: readonly string[]): Promise<void> {
    // The picker shows current members checked, so a confirm can carry ids
    // already in the series. The action no-ops on those; filtering here keeps
    // the toast's count honest about what actually changed.
    const added = ids.filter((id) => !memberIds.includes(id));
    if (added.length === 0) return;

    try {
      const result = await addAnimeToSeriesAction(seriesId, added);
      if (result.ok) {
        toast.success(`${added.length} show${added.length === 1 ? '' : 's'} added to ${seriesTitle}`);
        return;
      }
      toast.error(result.error);
    } catch {
      toast.error('That did not save. Nothing was changed.');
    }
  }

  async function remove(member: Anime): Promise<void> {
    setRemovingId(member.id);
    try {
      const result = await setAnimeSeriesAction(member.id, null);
      if (result.ok) {
        // Says where the show WENT, not merely that something happened:
        // "removed" on its own reads like a deletion, and this deletes nothing.
        toast.success(`${member.titleRomaji} is now a standalone show`);
        return;
      }
      toast.error(result.error);
    } catch {
      toast.error('That did not save. Nothing was changed.');
    } finally {
      // `finally`, not a line after the await: a REJECTED Server Action skips
      // everything below it, which would leave every X in this list disabled.
      setRemovingId(null);
    }
  }

  return (
    <>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-muted-foreground text-xs font-medium">Shows in this series</h2>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground text-xs">
            {members.length} show{members.length === 1 ? '' : 's'}
          </span>
          <Button size="sm" variant="outline" onClick={() => setPicking(true)}>
            <Plus className="size-3.5" aria-hidden />
            Add shows
          </Button>
        </div>
      </div>

      {members.length === 0 ? (
        <p className="text-muted-foreground bg-card rounded-md px-4 py-6 text-sm">
          Nothing in this series yet. Add the seasons, films and OVAs it covers — each still counts as
          its own show in your library.
        </p>
      ) : (
        <ul className="bg-card divide-y rounded-md px-4">
          {members.map((member) => {
            const watched = episodesWatched(member.progress, member.repeatCount, member.episodes);
            const minutes = minutesWatched(
              member.progress,
              member.repeatCount,
              member.episodes,
              member.durationMinutes,
            );
            const airing = formatAiring(member.season, member.seasonYear);

            return (
              <li key={member.id} className="flex items-center gap-1">
                <Link
                  href={`/anime/${member.id}`}
                  className="hover:bg-muted/50 -mx-2 flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors"
                >
                  <span className="bg-muted relative h-12 w-9 shrink-0 overflow-hidden rounded-md">
                    {member.coverUrl === null ? (
                      <span
                        className="text-muted-foreground/50 flex h-full items-center justify-center text-xs font-semibold"
                        aria-hidden
                      >
                        {member.titleRomaji.trim().charAt(0).toUpperCase()}
                      </span>
                    ) : (
                      <Image src={member.coverUrl} alt="" fill sizes="36px" className="object-cover" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{member.titleRomaji}</span>
                  {/* Both of these are `hidden sm:inline`. At 390px the row is
                      cover + title + status + the remove button, and adding
                      the airing season and the episode figure pushed the page
                      to 401px — measured. Hiding rather than wrapping keeps
                      every member one line tall, which is what makes a
                      six-season franchise scannable; the same two facts are on
                      the show's own page one tap away. */}
                  {airing === null ? null : (
                    <span className="text-muted-foreground hidden shrink-0 text-xs sm:inline">{airing}</span>
                  )}
                  <span className="text-muted-foreground tabular hidden shrink-0 text-xs sm:inline">
                    {watched} ep{watched === 1 ? '' : 's'}
                    {minutes === null ? '' : ` · ${formatRuntime(minutes)}`}
                  </span>
                  <StatusBadge tone={STATUS_TONES[member.status]}>{STATUS_LABELS[member.status]}</StatusBadge>
                </Link>

                <Button
                  variant="ghost"
                  size="icon"
                  // Named, not just "Remove": a franchise of near-identical
                  // season titles makes a bare label read the same on every
                  // button in the list to a screen reader.
                  aria-label={`Remove ${member.titleRomaji} from ${seriesTitle}`}
                  onClick={() => void remove(member)}
                  disabled={removingId !== null}
                  className="size-8 shrink-0"
                >
                  {removingId === member.id ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  ) : (
                    <X className="size-3.5" aria-hidden />
                  )}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <AnimePickerDialog
        open={picking}
        onOpenChange={setPicking}
        multiple
        title={`Add shows to ${seriesTitle}`}
        description="Shows already in another series aren't listed — remove them there first."
        shows={candidates}
        selectedIds={memberIds}
        confirmLabel="Add to series"
        emptyMessage="No show matches that search."
        onConfirm={add}
      />
    </>
  );
}
