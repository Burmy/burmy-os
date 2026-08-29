import Link from 'next/link';

import { TrophyTierBadge } from '@/components/games/trophy-tier-badge';
import type {
  CloseToPlatinumRow,
  EarnedTrophyRow,
} from '@/server/db/games/trophies';
import { formatRarity } from '@/server/games/trophies';

/**
 * The three trophy lists on the Stats page.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THESE EXIST AND WHY THEY LIVE ON STATS.
 *
 * Trophies used to be visible one game at a time and nowhere else — the app
 * could show you a list if you navigated to a specific game, and could not
 * answer a single question ABOUT your trophies. Now that they are persisted,
 * these are the three questions worth asking: what am I close to finishing,
 * what did I do lately, and what do I own that almost nobody else does.
 *
 * They sit ABOVE `Year by year` on Stats rather than in a tab of their own.
 * The hunt is current; the year-by-year table is history, and history reads
 * better underneath.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * All three are pure presentation over rows the server already aggregated in
 * SQL — no filtering, sorting or counting happens here. Each renders nothing
 * at all when empty rather than an "everything is done!" placeholder: with
 * three lists side by side, three empty-state paragraphs is more chrome than
 * the absence of data deserves.
 */

function GameLink({ gameId, title }: { readonly gameId: string; readonly title: string }): React.ReactElement {
  return (
    <Link href={`/games/${gameId}`} className="hover:text-foreground truncate transition-colors">
      {title}
    </Link>
  );
}

/**
 * A short, coarse "how long ago" for a trophy date. Distinct from
 * `src/lib/relative-time.ts` on purpose: that one phrases a wall-clock gap in
 * minutes/hours for a sync that just ran, while this one only ever deals in
 * whole days and reads off an ISO date string with no time in it at all.
 */
function earnedAgo(iso: string, now: Date): string {
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * Ordered by trophies REMAINING, which the DAL does — three left beats 91% of
 * a two-hundred-trophy list, and that ordering is the entire point of the
 * list. The count is shown the same way: "3 left", not a percentage.
 */
export function CloseToPlatinumList({ rows }: { readonly rows: readonly CloseToPlatinumRow[] }): React.ReactElement | null {
  if (rows.length === 0) return null;

  return (
    <div>
      <h3 className="text-muted-foreground mb-3 text-xs font-medium">Close to platinum</h3>
      <ol className="space-y-2 text-sm">
        {rows.map((row) => (
          <li key={row.gameId} className="flex items-baseline justify-between gap-3">
            <GameLink gameId={row.gameId} title={row.title} />
            <span className="text-muted-foreground tabular shrink-0 text-xs">
              {row.remaining} left
              <span className="opacity-60">
                {' · '}
                {row.earned}/{row.total}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function RecentlyEarnedList({
  rows,
  now,
}: {
  readonly rows: readonly EarnedTrophyRow[];
  /** Passed in, never read here, so the rendering stays deterministic and testable — same rule the stats page uses for `currentYear`. */
  readonly now: Date;
}): React.ReactElement | null {
  if (rows.length === 0) return null;

  return (
    <div>
      <h3 className="text-muted-foreground mb-3 text-xs font-medium">Earned recently</h3>
      <ol className="space-y-2 text-sm">
        {rows.map((row) => (
          <li key={`${row.gameId}-${row.name ?? ''}-${row.earnedAt ?? ''}`} className="flex items-baseline gap-3">
            <TrophyTierBadge tier={row.tier} className="size-4 shrink-0 translate-y-0.5" />
            <span className="min-w-0 flex-1 truncate">
              {row.name ?? 'Untitled trophy'}
              <span className="text-muted-foreground text-xs"> · {row.gameTitle}</span>
            </span>
            <span className="text-muted-foreground shrink-0 text-xs">
              {row.earnedAt === null ? '' : earnedAgo(row.earnedAt, now)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Rarity comes from the source's own global figure — PSN's `trophyEarnedRate`
 * and Steam's `GetGlobalAchievementPercentagesForApp`. Stored as tenths of a
 * percent in an integer; `formatRarity` is the only thing that turns it back
 * into a string. See `server/games/trophies.ts` for why it is never a float.
 */
export function RarestEarnedList({ rows }: { readonly rows: readonly EarnedTrophyRow[] }): React.ReactElement | null {
  if (rows.length === 0) return null;

  return (
    <div>
      <h3 className="text-muted-foreground mb-3 text-xs font-medium">Rarest earned</h3>
      <ol className="space-y-2 text-sm">
        {rows.map((row) => (
          <li key={`${row.gameId}-${row.name ?? ''}`} className="flex items-baseline gap-3">
            <TrophyTierBadge tier={row.tier} className="size-4 shrink-0 translate-y-0.5" />
            <span className="min-w-0 flex-1 truncate">
              {row.name ?? 'Untitled trophy'}
              <span className="text-muted-foreground text-xs"> · {row.gameTitle}</span>
            </span>
            <span className="text-muted-foreground tabular shrink-0 text-xs">{formatRarity(row.rarityTenths)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
