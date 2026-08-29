import type { Metadata } from 'next';

import { AnimeLibraryView } from '@/features/anime/library/library-view';
import { requireOwner } from '@/server/auth/owner';
import { listAnime } from '@/server/db/anime/anime';

export const metadata: Metadata = { title: 'Anime — Burmy' };

export default async function AnimeLibraryPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();
  const anime = await listAnime(owner.userId);

  return <AnimeLibraryView anime={anime} />;
}
