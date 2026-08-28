import type { Metadata } from 'next';

import { LibraryView } from '@/features/games/library/library-view';
import { requireOwner } from '@/server/auth/owner';
import { listDuplicateCandidates } from '@/server/db/games/duplicates';
import { listGames } from '@/server/db/games/games';
import { findDuplicates } from '@/server/games/duplicates';

export const metadata: Metadata = { title: 'Games — Burmy' };

export default async function GamesLibraryPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();
  // Sync trigger buttons (and their configured-state checks) now live
  // entirely in Settings → Games → Sync (`/settings`, via
  // `games-sync-section.tsx`) — this page no longer renders them at all, so
  // it only needs the games themselves.
  // The duplicate COUNT only — the Duplicates screen itself does the work.
  // Fetched here so the link can appear only when there is something behind
  // it: a permanent "Duplicates" tab reading "0" on a clean library is a
  // standing invitation to a page with nothing on it.
  const [games, candidates] = await Promise.all([
    listGames(owner.userId),
    listDuplicateCandidates(owner.userId),
  ]);

  const { merges, review } = findDuplicates(candidates.rows, {
    holdsMembers: candidates.holdsMembers,
    hasTrophies: candidates.hasTrophies,
  });

  return <LibraryView games={games} duplicateCount={merges.length + review.length} />;
}
