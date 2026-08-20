import type { Metadata } from 'next';

import { requireOwner } from '@/server/auth/owner';
import { listGames } from '@/server/db/games/games';

export const metadata: Metadata = { title: 'Games — Burmy' };

export default async function GamesLibraryPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();
  const games = await listGames(owner.userId);

  return (
    <div>
      <h1 className="text-xl font-semibold">Library</h1>
      <p className="text-muted-foreground mt-1 text-sm">{games.length} games</p>
    </div>
  );
}
