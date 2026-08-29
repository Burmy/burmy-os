import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { AnimePage } from '@/features/anime/show/anime-page';
import { isUuid } from '@/lib/uuid';
import { requireOwner } from '@/server/auth/owner';
import { type Anime, type AnimeSeriesRow, getAnime, listSeries } from '@/server/db/anime/anime';
import { type WatchLogEntry, listWatchLogForAnime } from '@/server/db/anime/watch-log';
import { AnimeNotFoundError } from '@/server/db/anime/errors';

export const metadata: Metadata = { title: 'Show — Burmy' };

/** How many history entries this page shows. The Log tab holds the complete record. */
const HISTORY_LIMIT = 100;

/**
 * The per-show page. A sibling of `(tabs)/` and `sync/[runId]/` rather than
 * nested inside the tabs group: the Library/Log/Stats sub-nav belongs to the
 * three list-shaped screens, not to a single-entity detail page — the same
 * shape `games/[id]` and `anime/sync/[runId]` already use, back-link included.
 *
 * `getAnime` throws `AnimeNotFoundError` for a missing row AND for one
 * belonging to someone else — one error for both, so a crafted id cannot be
 * used to probe another owner's data. The `isUuid` guard runs first so a
 * non-UUID segment never reaches Postgres as a malformed `uuid` literal, which
 * would surface as a 500 rather than a 404.
 */
export default async function AnimeDetailPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const owner = await requireOwner();

  // The fetch is inside the try; the JSX is deliberately NOT. React renders a
  // component after this function returns, so an error thrown during its
  // render would escape a `catch` here anyway — and `react-hooks/error-boundaries`
  // rejects the shape outright rather than letting it look like it works.
  let anime: Anime;
  let allSeries: AnimeSeriesRow[];
  let history: WatchLogEntry[];
  try {
    [anime, allSeries, history] = await Promise.all([
      getAnime(owner.userId, id),
      listSeries(owner.userId),
      // Capped: a 1,000-episode show's full history is not something anyone
      // reads to the bottom of, and the Log tab holds the complete record.
      listWatchLogForAnime(owner.userId, id, HISTORY_LIMIT),
    ]);
  } catch (error) {
    if (error instanceof AnimeNotFoundError) notFound();
    throw error;
  }

  const series = allSeries.find((row) => row.id === anime.seriesId) ?? null;

  return (
    <AnimePage
      anime={anime}
      series={series === null ? null : { id: series.id, title: series.title }}
      seriesOptions={allSeries.map((row) => ({ id: row.id, title: row.title }))}
      history={history}
    />
  );
}
