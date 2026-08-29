import type { Metadata } from 'next';

import { AnimeLogView } from '@/features/anime/log/log-view';
import { requireOwner } from '@/server/auth/owner';
import { getWatchLogBounds, listWatchLog } from '@/server/db/anime/watch-log';

export const metadata: Metadata = { title: 'Anime log — Burmy' };

/**
 * A hard page size, and the SCREEN SAYS SO when it truncates.
 *
 * A daily watcher accumulates thousands of entries, and rendering all of them
 * would be a slow page whose slowness has no upper bound. 500 covers well over
 * a year of heavy viewing; `getWatchLogBounds` supplies the real total so the
 * view can state what it is not showing rather than quietly stopping.
 */
const LOG_PAGE_SIZE = 500;

export default async function AnimeLogPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();
  const [entries, bounds] = await Promise.all([
    listWatchLog(owner.userId, LOG_PAGE_SIZE),
    getWatchLogBounds(owner.userId),
  ]);

  return <AnimeLogView entries={entries} bounds={bounds} limit={LOG_PAGE_SIZE} />;
}
