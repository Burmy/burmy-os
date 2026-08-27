import type { Metadata } from 'next';

import { LibraryView } from '@/features/games/library/library-view';
import { requireOwner } from '@/server/auth/owner';
import { listGames } from '@/server/db/games/games';

export const metadata: Metadata = { title: 'Games — Burmy' };

export default async function GamesLibraryPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();
  // Sync trigger buttons (and their configured-state checks) now live
  // entirely in Settings → Games → Sync (`/settings`, via
  // `games-sync-section.tsx`) — this page no longer renders them at all, so
  // it only needs the games themselves.
  const games = await listGames(owner.userId);

  return <LibraryView games={games} />;
}
