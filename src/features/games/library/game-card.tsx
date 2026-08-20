'use client';

import Image from 'next/image';
import { Gamepad2 } from 'lucide-react';

import { RatingStars } from '@/components/games/rating-stars';
import { StatusBadge } from '@/components/games/status-badge';
import { cn } from '@/lib/utils';
import type { Game } from '@/server/db/games/games';
import { PLATFORM_LABELS, STATUS_LABELS } from '@/server/games/taxonomy';
import { formatHours, hours } from '@/server/games/hours';

/**
 * One game in the gallery. Cover art is the primary affordance; everything else
 * is secondary metadata layered beneath it. Games with no cover fall back to a
 * plain icon tile rather than a broken-image box — roughly half the historical
 * library predates cover art being available at all. The title always renders
 * in the info panel below, cover or not, so every card has identical structure
 * and a mixed grid never looks ragged.
 */
export function GameCard({
  game,
  onOpen,
}: {
  readonly game: Game;
  readonly onOpen: (game: Game) => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      // Without an explicit aria-label, the accessible name is computed from
      // ALL visible content in DOM order — status badge, title, platform,
      // rating, hours — a wall of text on every card, and it collides with
      // the status filter chips' own "Backlog"/"Playing" names. Title alone
      // isn't enough either: status is the card's most prominent visual
      // signal (a colored badge) with no other channel for a screen-reader
      // user tabbing the gallery — unlike the table view, which exposes
      // status in its own dedicated "Status" cell. So the name is title plus
      // status, and nothing else from the card's remaining content.
      aria-label={`${game.title} — ${STATUS_LABELS[game.status]}`}
      onClick={() => onOpen(game)}
      className={cn(
        'group focus-visible:ring-ring flex flex-col overflow-hidden rounded-lg border text-left',
        'transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:outline-none',
      )}
    >
      <div className="bg-muted relative aspect-[3/4] w-full overflow-hidden">
        {game.coverUrl === null ? (
          <div className="flex h-full items-center justify-center p-3">
            <Gamepad2 className="text-muted-foreground/40 size-8" aria-hidden />
          </div>
        ) : (
          <Image
            src={game.coverUrl}
            alt=""
            fill
            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 25vw, 200px"
            className="object-cover transition-transform group-hover:scale-[1.03]"
          />
        )}
        <div className="absolute top-2 left-2">
          <StatusBadge status={game.status} />
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-1 p-3">
        <span className="line-clamp-2 text-sm font-medium">{game.title}</span>
        <span className="text-muted-foreground text-xs">
          {PLATFORM_LABELS[game.platform]}
          {game.firstPlayedYear === null ? '' : ` · ${game.firstPlayedYear}`}
        </span>
        <div className="mt-auto flex items-center justify-between pt-2">
          <RatingStars rating={game.rating} />
          {game.hoursTenths === null ? null : (
            <span className="text-muted-foreground tabular text-xs">
              {formatHours(hours(game.hoursTenths))}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
