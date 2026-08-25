import type { Metadata } from 'next';

import { LibraryView } from '@/features/games/library/library-view';
import { isSteamConfiguredAction } from '@/features/games/sync/sync-actions';
import { requireOwner } from '@/server/auth/owner';
import { listGames } from '@/server/db/games/games';

export const metadata: Metadata = { title: 'Games — Burmy' };

export default async function GamesLibraryPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();
  // `isSteamConfiguredAction` only reads `process.env` — calling it directly
  // here (rather than round-tripping through a client-side effect) means the
  // Sync button's disabled/enabled state is correct on first paint, with no
  // "unknown while checking" flash.
  const [games, steamConfigured] = await Promise.all([listGames(owner.userId), isSteamConfiguredAction()]);

  return <LibraryView games={games} steamConfigured={steamConfigured} />;
}
