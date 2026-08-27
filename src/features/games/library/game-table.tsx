'use client';

import { PlatinumBadge } from '@/components/games/platinum-badge';
import { RatingStars } from '@/components/games/rating-stars';
import { StatusBadge } from '@/components/games/status-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import type { Game } from '@/server/db/games/games';
import { PLATFORM_LABELS } from '@/server/games/taxonomy';
import { formatHours, hours } from '@/server/games/hours';

/**
 * The dense view — deliberately close to the spreadsheet this replaces, because
 * scanning and comparing 100 rows is a genuinely different task from browsing,
 * and a card grid is bad at it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ROW ACTIVATION IS A REAL BUTTON IN THE FIRST CELL, NOT `onClick` ON `<tr>`.
 *
 * `TableRow` keeps its `onClick` as a mouse-only convenience (click anywhere in
 * the row), but that alone leaves keyboard users with no way to open a game —
 * a `<tr>` is not natively focusable and giving it `role="button"` would strip
 * its implicit `row` semantics from screen readers, along with its cells'
 * `cell` semantics, for no real gain. A native `<button>` around the title gets
 * correct tab-order focus, a visible focus ring, and Enter/Space activation
 * for free from the browser — no `onKeyDown` hand-rolling needed — and its
 * accessible name (the title text) says exactly which game it opens.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function GameTable({
  games,
  onOpen,
}: {
  readonly games: readonly Game[];
  readonly onOpen: (game: Game) => void;
}): React.ReactElement {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
          <TableHead>Platform</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Hours</TableHead>
          <TableHead className="text-right">Year</TableHead>
          <TableHead className="text-right">Achievements</TableHead>
          <TableHead>Rating</TableHead>
          <TableHead>Platinum</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {games.map((game) => (
          <TableRow
            key={game.id}
            className="cursor-pointer"
            onClick={() => onOpen(game)}
          >
            <TableCell className="font-medium">
              <button
                type="button"
                onClick={(event) => {
                  // The row above already opens on click; stop the event
                  // reaching it so a mouse click doesn't call onOpen twice.
                  event.stopPropagation();
                  onOpen(game);
                }}
                className={cn(
                  'rounded-md text-left focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
                )}
              >
                {game.title}
              </button>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {PLATFORM_LABELS[game.platform]}
              {/* Same provenance mark as game-card.tsx, folded into the existing
                  Platform cell rather than a new column — compact, and this is
                  specifically "does Steam own this game's data," independent of
                  the `platform` field itself (a `steam` platform game can still
                  be unlinked). */}
              {game.steamAppid === null ? '' : ' · Steam'}
            </TableCell>
            <TableCell>
              <StatusBadge status={game.status} />
            </TableCell>
            <TableCell className="tabular text-right">
              {game.hoursTenths === null ? '—' : formatHours(hours(game.hoursTenths))}
            </TableCell>
            <TableCell className="tabular text-right">{game.firstPlayedYear ?? '—'}</TableCell>
            <TableCell className="tabular text-right">
              {game.achievementsUnlocked === null
                ? '—'
                : `${game.achievementsUnlocked}${game.achievementsTotal === null ? '' : ` / ${game.achievementsTotal}`}`}
            </TableCell>
            <TableCell>
              <RatingStars rating={game.rating} />
            </TableCell>
            <TableCell>
              {/* PlatinumBadge is icon-only and aria-hidden by design (the
                  card view folds its meaning into the card's own aria-label
                  instead) — this sr-only text is the table view's own
                  equivalent, since a table cell has no such wrapper to fold
                  it into. */}
              {game.platinum ? (
                <span className="inline-flex items-center gap-1.5">
                  <PlatinumBadge />
                  <span className="sr-only">Platinum</span>
                </span>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
