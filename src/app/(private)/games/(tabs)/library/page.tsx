import type { Metadata } from 'next';

import { LibraryView } from '@/features/games/library/library-view';
import { requireOwner } from '@/server/auth/owner';
import { hasCustomOrder, listGames } from '@/server/db/games/games';

export const metadata: Metadata = { title: 'Games — Burmy' };

export default async function GamesLibraryPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();
  const [games, customOrder] = await Promise.all([
    listGames(owner.userId),
    hasCustomOrder(owner.userId),
  ]);

  return <LibraryView games={games} customOrder={customOrder} />;
}
