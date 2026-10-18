import type { Metadata } from 'next';

import { UpcomingView } from '@/features/games/upcoming/upcoming-view';
import { requireOwner } from '@/server/auth/owner';
import { listGames, listWishlistIgdbIds } from '@/server/db/games/games';
import { fetchUpcomingGames, igdbConfigured } from '@/server/db/games/igdb';
import { excludeOwned, groupByMonth } from '@/server/games/upcoming';

export const metadata: Metadata = { title: 'Upcoming games — Burmy' };

export default async function GamesUpcomingPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();

  // `igdbConfigured()` is a plain env check, not awaited data — it never
  // races the three real reads below.
  const [upcoming, ownedIgdbIds, wishlist] = await Promise.all([
    fetchUpcomingGames(),
    listWishlistIgdbIds(owner.userId),
    listGames(owner.userId, { status: 'wanted' }),
  ]);

  // The clock is read HERE, once, and threaded through `groupByMonth` — same
  // reproducibility rule the Stats page follows for its own `currentYear`.
  // A game the owner already has a row for is dropped from the feed: it is
  // listed in "Your wishlist" above the feed, and showing it twice on one
  // page said nothing the first copy did not.
  const months = excludeOwned(groupByMonth(upcoming, new Date()), ownedIgdbIds);

  return <UpcomingView months={months} wishlist={wishlist} igdbConfigured={igdbConfigured()} />;
}
