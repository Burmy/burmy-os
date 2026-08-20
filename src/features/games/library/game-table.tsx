'use client';

import { RatingStars } from '@/components/games/rating-stars';
import { StatusBadge } from '@/components/games/status-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { Game } from '@/server/db/games/games';
import { PLATFORM_LABELS } from '@/server/games/taxonomy';
import { formatHours, hours } from '@/server/games/hours';

/**
 * The dense view — deliberately close to the spreadsheet this replaces, because
 * scanning and comparing 100 rows is a genuinely different task from browsing,
 * and a card grid is bad at it.
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
        </TableRow>
      </TableHeader>
      <TableBody>
        {games.map((game) => (
          <TableRow
            key={game.id}
            className="cursor-pointer"
            onClick={() => onOpen(game)}
          >
            <TableCell className="font-medium">{game.title}</TableCell>
            <TableCell className="text-muted-foreground">{PLATFORM_LABELS[game.platform]}</TableCell>
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
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
