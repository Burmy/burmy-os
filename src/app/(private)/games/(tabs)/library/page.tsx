import type { Metadata } from 'next';

import { LibraryView } from '@/features/games/library/library-view';
import { isPsnConfiguredAction } from '@/features/games/sync/psn-actions';
import { isSteamConfiguredAction } from '@/features/games/sync/sync-actions';
import { requireOwner } from '@/server/auth/owner';
import { listGames } from '@/server/db/games/games';

export const metadata: Metadata = { title: 'Games — Burmy' };

export default async function GamesLibraryPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();
  // `isSteamConfiguredAction`/`isPsnConfiguredAction` only read `process.env`
  // — calling them directly here (rather than round-tripping through a
  // client-side effect) means each Sync button's disabled/enabled state is
  // correct on first paint, with no "unknown while checking" flash.
  //
  // Last-synced times and PSN token age used to be fetched here too, for the
  // buttons' own captions — that status now lives in Settings → Games →
  // Sync (`/settings`, via `games-sync-section.tsx`), so this page no
  // longer needs either query.
  const [games, steamConfigured, psnConfigured] = await Promise.all([
    listGames(owner.userId),
    isSteamConfiguredAction(),
    isPsnConfiguredAction(),
  ]);

  return <LibraryView games={games} steamConfigured={steamConfigured} psnConfigured={psnConfigured} />;
}
