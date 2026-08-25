import type { Metadata } from 'next';

import { LibraryView } from '@/features/games/library/library-view';
import { getPsnTokenAgeAction, isPsnConfiguredAction } from '@/features/games/sync/psn-actions';
import { getLastSyncedTimesAction, isSteamConfiguredAction } from '@/features/games/sync/sync-actions';
import { requireOwner } from '@/server/auth/owner';
import { listGames } from '@/server/db/games/games';

export const metadata: Metadata = { title: 'Games — Burmy' };

export default async function GamesLibraryPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();
  // `isSteamConfiguredAction`/`isPsnConfiguredAction` only read `process.env`
  // — calling them directly here (rather than round-tripping through a
  // client-side effect) means each Sync button's disabled/enabled state is
  // correct on first paint, with no "unknown while checking" flash. The two
  // new calls below follow the same reasoning for the "Synced …" line and
  // the PSN token-age note.
  const [games, steamConfigured, psnConfigured, lastSyncedTimes, psnTokenAge] = await Promise.all([
    listGames(owner.userId),
    isSteamConfiguredAction(),
    isPsnConfiguredAction(),
    getLastSyncedTimesAction(),
    getPsnTokenAgeAction(),
  ]);

  return (
    <LibraryView
      games={games}
      steamConfigured={steamConfigured}
      psnConfigured={psnConfigured}
      steamLastSyncedAt={lastSyncedTimes.steam}
      psnLastSyncedAt={lastSyncedTimes.psn}
      psnTokenAge={psnTokenAge}
    />
  );
}
