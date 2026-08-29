import type { Metadata } from 'next';

import { PageHeader } from '@/components/ui/page-header';
import { AnimeDashboard } from '@/features/anime/dashboard/anime-dashboard';
import { requireOwner } from '@/server/auth/owner';
import { listAnimeStatRows } from '@/server/db/anime/anime';

export const metadata: Metadata = { title: 'Anime stats — Burmy' };

/**
 * Every figure on this page is computed at read time from `anime` rows —
 * nothing is stored, per CLAUDE.md's first invariant.
 *
 * The read is a NARROW PROJECTION rather than the full library: the dashboard
 * needs fifteen columns and none of the long text (synopsis, notes), and
 * shipping a few hundred synopses to render a bar chart is bytes for nothing.
 */
export default async function AnimeStatsPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();
  const rows = await listAnimeStatRows(owner.userId);

  return (
    <div className="min-w-0 space-y-8">
      {/* No prose line. `PageHeader` deliberately has no slot for one — each
          Section below carries its own description, which is where an
          explanation belongs. */}
      <PageHeader title="Stats" />
      <AnimeDashboard rows={rows} />
    </div>
  );
}
