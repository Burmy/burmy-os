import type { Metadata } from 'next';

import { PageHeader } from '@/components/ui/page-header';
import { GamesDashboard } from '@/features/games/dashboard/games-dashboard';
import { requireOwner } from '@/server/auth/owner';
import { listGameStatRows } from '@/server/db/games/games';
import { listPlayYears } from '@/server/db/games/play-years';
import {
  getCompletionSummary,
  listCloseToPlatinum,
  listRarestEarned,
  listRecentlyEarned,
} from '@/server/db/games/trophies';

export const metadata: Metadata = { title: 'Game stats — Burmy' };

export default async function GamesStatsPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();
  // One round trip for all six, not six sequential awaits — the four trophy
  // queries are independent of each other and of the library rows.
  const [rows, playYears, completion, closeToPlatinum, recentlyEarned, rarestEarned] = await Promise.all([
    listGameStatRows(owner.userId),
    listPlayYears(owner.userId),
    getCompletionSummary(owner.userId),
    listCloseToPlatinum(owner.userId),
    listRecentlyEarned(owner.userId),
    listRarestEarned(owner.userId),
  ]);

  // The clock is read HERE and passed down, so every pure function below stays
  // reproducible and testable without mocking time.
  const now = new Date();
  const currentYear = now.getUTCFullYear();

  return (
    <div className="space-y-8">
      <PageHeader title="Stats" />
      <GamesDashboard
        rows={rows}
        playYears={playYears}
        currentYear={currentYear}
        completion={completion}
        closeToPlatinum={closeToPlatinum}
        recentlyEarned={recentlyEarned}
        rarestEarned={rarestEarned}
        now={now}
      />
    </div>
  );
}
