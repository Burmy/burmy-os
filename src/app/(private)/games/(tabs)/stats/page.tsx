import type { Metadata } from 'next';

import { requireOwner } from '@/server/auth/owner';
import { listGameStatRows } from '@/server/db/games/games';

export const metadata: Metadata = { title: 'Game stats — Burmy' };

export default async function GamesStatsPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();
  const rows = await listGameStatRows(owner.userId);

  return (
    <div>
      <h1 className="text-xl font-semibold">Stats</h1>
      <p className="text-muted-foreground mt-1 text-sm">{rows.length} games tracked</p>
    </div>
  );
}
