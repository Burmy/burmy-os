import type { Metadata } from 'next';

import { PageHeader } from '@/components/ui/page-header';
import { GamesDashboard } from '@/features/games/dashboard/games-dashboard';
import { requireOwner } from '@/server/auth/owner';
import { listGameStatRows } from '@/server/db/games/games';
import { listPlayYears } from '@/server/db/games/play-years';

export const metadata: Metadata = { title: 'Game stats — Burmy' };

export default async function GamesStatsPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();
  const [rows, playYears] = await Promise.all([
    listGameStatRows(owner.userId),
    listPlayYears(owner.userId),
  ]);

  // The clock is read HERE and passed down, so every pure function below stays
  // reproducible and testable without mocking time.
  const currentYear = new Date().getUTCFullYear();

  return (
    <div className="space-y-4">
      {/* Bordered/`bg-card` toolbar treatment, matching Finance's monthly
          dashboard header exactly — the Games Stats page previously had no
          header chrome at all. */}
      <PageHeader title="Stats" titleClassName="text-lg" className="rounded-lg border bg-card px-4 py-3" />
      <GamesDashboard rows={rows} playYears={playYears} currentYear={currentYear} />
    </div>
  );
}
