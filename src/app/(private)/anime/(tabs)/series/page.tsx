import type { Metadata } from 'next';

import { SeriesListView } from '@/features/anime/series/series-list-view';
import { requireOwner } from '@/server/auth/owner';
import { listSeriesWithMembers } from '@/server/db/anime/anime';

export const metadata: Metadata = { title: 'Anime series — Burmy' };

/**
 * Every franchise. Two queries, never one per series — see
 * `listSeriesWithMembers`, which also explains why nothing is aggregated in
 * SQL: the totals come from the same pure function the series page uses, so
 * the list and the page cannot disagree.
 */
export default async function AnimeSeriesListPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();
  const series = await listSeriesWithMembers(owner.userId);

  return <SeriesListView series={series} />;
}
