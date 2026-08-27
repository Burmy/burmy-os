import Image from 'next/image';

import { formatHours, hours } from '@/server/games/hours';
import { formatPriceCents } from '@/server/games/money';
import type { LeaderboardEntry, LeaderboardMetric } from '@/server/games/stats';
import { PLATFORM_LABELS } from '@/server/games/taxonomy';

/**
 * One "top 3" leaderboard.
 *
 * The value is formatted HERE rather than in `buildLeaderboard`, which returns
 * each metric in its own raw unit (tenths, a 1-5 rating, a trophy count, cents
 * per hour). That keeps `src/server/games/` free of display concerns, the same
 * split every other stat in this module uses.
 *
 * A metric with fewer than three qualifying games renders however many it has
 * rather than padding — `buildLeaderboard` excludes games with no value for a
 * metric, so a short list means "only two games are rated," not "the data is
 * broken."
 */
export function TopGames({
  title,
  hint,
  metric,
  entries,
}: {
  readonly title: string;
  readonly hint: string;
  readonly metric: LeaderboardMetric;
  readonly entries: readonly LeaderboardEntry[];
}): React.ReactElement {
  return (
    <div className="bg-card rounded-lg p-4">
      <div className="mb-3">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-muted-foreground text-xs">{hint}</p>
      </div>

      {entries.length === 0 ? (
        <p className="text-muted-foreground py-6 text-center text-xs">Nothing to rank yet.</p>
      ) : (
        <ol className="space-y-2">
          {entries.map((entry, index) => (
            <li key={entry.id} className="flex items-center gap-3">
              <span className="text-muted-foreground w-3 shrink-0 text-center text-xs font-semibold tabular">
                {index + 1}
              </span>
              <div className="bg-muted relative h-14 w-[2.625rem] shrink-0 overflow-hidden rounded">
                {entry.coverUrl === null ? (
                  // The game's own initial standing in for missing art, the same
                  // convention `game-card.tsx` uses. Decorative — the title is
                  // right beside it, so a screen reader repeating it would be noise.
                  <span
                    className="text-muted-foreground flex h-full items-center justify-center text-sm font-semibold"
                    aria-hidden
                  >
                    {entry.title.charAt(0).toUpperCase()}
                  </span>
                ) : (
                  <Image src={entry.coverUrl} alt="" fill sizes="42px" className="object-cover" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{entry.title}</p>
                <p className="text-muted-foreground text-xs">{PLATFORM_LABELS[entry.platform]}</p>
              </div>
              <span className="shrink-0 text-sm font-medium tabular">{formatValue(metric, entry.value)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function formatValue(metric: LeaderboardMetric, value: number): string {
  switch (metric) {
    case 'hours':
      return formatHours(hours(value));
    case 'rating':
      return `${value}★`;
    case 'trophies':
      return String(value);
    case 'costPerHour':
      return `${formatPriceCents(value)}/h`;
  }
}
