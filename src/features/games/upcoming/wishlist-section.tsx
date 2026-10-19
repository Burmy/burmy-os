'use client';

import Image from 'next/image';
import { ChevronDown, Gamepad2, Loader2 } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toast';
import { updateGameFieldAction } from '@/features/games/game-actions';
import { useGamePanel } from '@/features/games/panel/game-panel-context';
import type { Game } from '@/server/db/games/games';
import { formatReleaseCountdown, isReleased, sortWishlist } from '@/server/games/release-date';
import { type GameStatus, PLATFORM_LABELS, STATUS_LABELS } from '@/server/games/taxonomy';

/** Where a wishlist entry goes next. `wanted` itself is where it already is. */
const QUICK_STATUSES = ['played'] as const satisfies readonly GameStatus[];

/**
 * Every `wanted` game the owner has, at the top of the Upcoming tab.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A WISHLIST ENTRY STAYS UNTIL THE OWNER MOVES IT.
 *
 * There used to be an auto-flip: a wanted game whose release date passed was
 * silently made `backlog` and dropped off this tab, and the IGDB feed below
 * only ever lists UNreleased titles, so a game vanished from Upcoming the day
 * it came out — the one day the owner most wanted to see it. Now `wanted`
 * means "on my radar, not started" for as long as the owner says so: a
 * released entry sorts to the top with an "Out now" mark and leaves only when
 * its status changes, here (the quick menu) or in the panel.
 *
 * This section also shows hand-added wishlist games, which the feed never
 * could (they have no IGDB id), sorted last under "No date" until the owner
 * types a release date in the panel.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function WishlistSection({
  games,
  now = new Date(),
}: {
  readonly games: readonly Game[];
  /** Injected by tests; the page reads the clock once per render otherwise. */
  readonly now?: Date;
}): React.ReactElement {
  const { openGame } = useGamePanel();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const sorted = sortWishlist(games, now);

  async function mark(game: Game, status: GameStatus): Promise<void> {
    // try/catch/finally, not a bare await: a rejecting action would otherwise
    // leave this row's menu disabled with no error shown.
    setPendingId(game.id);
    try {
      const result = await updateGameFieldAction(game.id, 'status', status);
      if (result.ok)
        toast.success(`${game.title} marked as ${STATUS_LABELS[status].toLowerCase()}`);
      else toast.error(result.error);
    } catch {
      toast.error(`${game.title} could not be updated. Try again.`);
    } finally {
      setPendingId(null);
    }
  }

  return (
    <section className="space-y-4" aria-labelledby="wishlist-heading">
      <div className="flex items-baseline justify-between">
        <h2 id="wishlist-heading" className="text-sm font-semibold">
          Your wishlist
        </h2>
        <span className="text-muted-foreground text-xs">
          {games.length} game{games.length === 1 ? '' : 's'}
        </span>
      </div>

      {sorted.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing on your wishlist yet. Add a game from the feed below, or add one from the Library
          with its status set to Wanted.
        </p>
      ) : (
        <ul className="bg-card divide-y rounded-md px-4">
          {sorted.map((game) => {
            const dated = game.releaseDate !== null && game.releasePrecision !== null;
            const released = dated && isReleased(game.releaseDate, game.releasePrecision, now);
            const line = dated
              ? formatReleaseCountdown(game.releaseDate, game.releasePrecision, now)
              : 'No date';
            const pending = pendingId === game.id;

            return (
              <li key={game.id} className="flex items-center gap-3 py-2 text-sm">
                <button
                  type="button"
                  aria-label={game.title}
                  onClick={() => openGame(game)}
                  className="hover:bg-muted/50 -mx-2 flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-1 text-left transition-colors"
                >
                  <span className="bg-muted relative h-12 w-9 shrink-0 overflow-hidden rounded-md">
                    {game.coverUrl === null ? (
                      <span
                        className="text-muted-foreground/50 flex h-full flex-col items-center justify-center text-xs font-semibold"
                        aria-hidden
                      >
                        {game.title.trim().charAt(0).toUpperCase()}
                        <Gamepad2 className="text-muted-foreground/30 size-3" />
                      </span>
                    ) : (
                      <Image
                        src={game.coverUrl}
                        alt=""
                        fill
                        sizes="36px"
                        className="object-cover"
                      />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{game.title}</span>
                    <span className="text-muted-foreground block text-xs">
                      {PLATFORM_LABELS[game.platform]} · {line}
                    </span>
                  </span>
                </button>

                {released ? (
                  <span className="bg-foreground text-background shrink-0 rounded-md px-1.5 py-0.5 text-[0.6875rem] font-medium tracking-wide uppercase">
                    Out now
                  </span>
                ) : null}

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      aria-label={`Mark ${game.title} as`}
                      className="shrink-0"
                    >
                      {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                      Mark as
                      <ChevronDown className="size-3.5" aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {QUICK_STATUSES.map((status) => (
                      <DropdownMenuItem key={status} onSelect={() => void mark(game, status)}>
                        {STATUS_LABELS[status]}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
