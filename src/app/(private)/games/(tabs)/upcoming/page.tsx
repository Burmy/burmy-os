import type { Metadata } from 'next';

import { UpcomingView } from '@/features/games/upcoming/upcoming-view';
import { requireOwner } from '@/server/auth/owner';
import { countOverdueWantedGames, listWishlistIgdbIds } from '@/server/db/games/games';
import { fetchUpcomingGames, igdbConfigured } from '@/server/db/games/igdb';
import { groupByMonth } from '@/server/games/upcoming';

export const metadata: Metadata = { title: 'Upcoming games — Burmy' };

export default async function GamesUpcomingPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();

  // `igdbConfigured()` is a plain env check, not awaited data — it never
  // races the two real fetches below.
  const [upcoming, wishlistedIgdbIds, overdueWantedCount] = await Promise.all([
    fetchUpcomingGames(),
    listWishlistIgdbIds(owner.userId),
    countOverdueWantedGames(owner.userId),
  ]);

  // The clock is read HERE, once, and threaded through `groupByMonth` — same
  // reproducibility rule the Stats page follows for its own `currentYear`.
  const months = groupByMonth(upcoming, new Date());

  return (
    <UpcomingView
      months={months}
      wishlistedIgdbIds={wishlistedIgdbIds}
      overdueWantedCount={overdueWantedCount}
      igdbConfigured={igdbConfigured()}
    />
  );
}
