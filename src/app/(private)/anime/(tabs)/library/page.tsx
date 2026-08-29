import type { Metadata } from 'next';

import { AnimeLibraryView } from '@/features/anime/library/library-view';
import { requireOwner } from '@/server/auth/owner';
import { listAnime, listSeries } from '@/server/db/anime/anime';

export const metadata: Metadata = { title: 'Anime — Burmy' };

/**
 * The library. Both reads are owner-scoped and independent, so they go in
 * parallel — the series list is needed for the filter dropdown and the bulk
 * "Add to series" picker, neither of which can be filled from the shows alone.
 */
export default async function AnimeLibraryPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();
  const [anime, series] = await Promise.all([listAnime(owner.userId), listSeries(owner.userId)]);

  return <AnimeLibraryView anime={anime} series={series} />;
}
