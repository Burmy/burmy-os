import type { Metadata } from 'next';

import { PageHeader } from '@/components/ui/page-header';
import { GamesDashboard } from '@/features/games/dashboard/games-dashboard';
import { requireOwner } from '@/server/auth/owner';
import { listDlc } from '@/server/db/games/dlc';
import { listGameStatRows } from '@/server/db/games/games';
import { listPlayYears } from '@/server/db/games/play-years';

export const metadata: Metadata = { title: 'Game stats — Burmy' };

export default async function GamesStatsPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();
  // One round trip for both — the two reads are independent of each other.
  const [rows, playYears, dlc] = await Promise.all([
    listGameStatRows(owner.userId),
    listPlayYears(owner.userId),
    listDlc(owner.userId),
  ]);

  // The clock is read HERE and passed down, so every pure function below stays
  // reproducible and testable without mocking time.
  const currentYear = new Date().getUTCFullYear();

  return (
    <div className="space-y-8">
      <PageHeader title="Stats" />
      <GamesDashboard rows={rows} playYears={playYears} dlc={dlc} currentYear={currentYear} />
    </div>
  );
}
