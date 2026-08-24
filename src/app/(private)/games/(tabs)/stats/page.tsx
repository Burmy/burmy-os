import type { Metadata } from 'next';

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

  return <GamesDashboard rows={rows} playYears={playYears} currentYear={currentYear} />;
}
