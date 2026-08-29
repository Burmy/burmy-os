import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { SeriesPage } from '@/features/anime/series/series-page';
import { isUuid } from '@/lib/uuid';
import { requireOwner } from '@/server/auth/owner';
import { type Anime, type AnimeSeriesRow, listSeriesCandidates, listSeriesMembers } from '@/server/db/anime/anime';
import { AnimeSeriesNotFoundError } from '@/server/db/anime/errors';
import { getSeries } from '@/server/db/anime/series';

export const metadata: Metadata = { title: 'Series — Burmy' };

/**
 * A franchise page. Its own top-level segment for the same reason `[id]` is:
 * the Library/Log/Stats sub-nav belongs to the list screens, and a series is a
 * single entity with a back-link, not a fourth tab.
 *
 * `getSeries` throws one error for "missing" and "not yours" alike, so a
 * crafted id cannot probe another owner's data, and the `isUuid` guard keeps a
 * junk segment from reaching Postgres as a malformed `uuid` literal.
 */
export default async function AnimeSeriesPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const owner = await requireOwner();

  // The fetch is inside the try; the JSX is deliberately NOT — see the same
  // note on `anime/[id]/page.tsx`.
  let series: AnimeSeriesRow;
  let members: Anime[];
  let candidates: Awaited<ReturnType<typeof listSeriesCandidates>>;
  try {
    [series, members, candidates] = await Promise.all([
      getSeries(owner.userId, id),
      listSeriesMembers(owner.userId, id),
      listSeriesCandidates(owner.userId, id),
    ]);
  } catch (error) {
    if (error instanceof AnimeSeriesNotFoundError) notFound();
    throw error;
  }

  return (
    <SeriesPage
      series={series}
      members={members}
      candidates={candidates.map((row) => ({
        id: row.id,
        title: row.title,
        ...(row.subtitle === null ? {} : { subtitle: row.subtitle }),
      }))}
    />
  );
}
