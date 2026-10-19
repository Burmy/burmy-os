'use client';

import Image from 'next/image';
import { Gamepad2 } from 'lucide-react';
import { useState } from 'react';

import { FoilCard } from '@/components/games/foil-card';
import { Button } from '@/components/ui/button';
import { GameDialog } from '@/features/games/library/game-dialog';
import { useGamePanel } from '@/features/games/panel/game-panel-context';
import type { Game } from '@/server/db/games/games';
import { formatReleaseCountdown, isReleased, sortWishlist } from '@/server/games/release-date';
import { PLATFORM_LABELS } from '@/server/games/taxonomy';

/**
 * Every `wanted` game the owner has, at the top of the Upcoming tab, as cover
 * cards — the same grid and the same card language as the IGDB feed below it
 * (`UpcomingGameCard`), so the tab reads as one wall of art with the owner's
 * own picks first.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A WISHLIST ENTRY STAYS UNTIL THE OWNER MOVES IT.
 *
 * There used to be an auto-flip: a wanted game whose release date passed was
 * silently made `backlog` and dropped off this tab, and the IGDB feed below
 * only ever lists UNreleased titles, so a game vanished from Upcoming the day
 * it came out — the one day the owner most wanted to see it. Now `wanted`
 * means "on my radar, not started" for as long as the owner says so: a
 * released entry sorts to the front with an "Out now" pill on its art and
 * leaves only when its status changes.
 *
 * "ADD TO LIBRARY" IS THE MOMENT A GAME ENTERS THE LIBRARY, so it opens the
 * add-game dialog pre-filled (`GameDialog`, `mode="complete"`) rather than
 * flipping one column: hours, price, year and rating get entered right then,
 * on the row that already exists — never a duplicate. The dialog is keyed on
 * the game so a fresh one mounts per card.
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
  const [completing, setCompleting] = useState<Game | null>(null);
  const sorted = sortWishlist(games, now);

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
        // Same column counts and gap as the feed and the library grid.
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
          {sorted.map((game) => (
            <WishlistCard
              key={game.id}
              game={game}
              now={now}
              onOpen={openGame}
              onComplete={setCompleting}
            />
          ))}
        </div>
      )}

      {completing === null ? null : (
        <GameDialog
          key={completing.id}
          mode="complete"
          game={completing}
          open
          onOpenChange={(open) => {
            if (!open) setCompleting(null);
          }}
        />
      )}
    </section>
  );
}

/**
 * Cover + letter-tile fallback mirrors `library/game-card.tsx` (same aspect
 * ratio, same frost foil for a wishlisted game). Unlike the library card it
 * carries text underneath — the title, the release line and the one action —
 * because a wishlist card is something you act on, not something you
 * recognise. (`played` is never printed anywhere — the action is "Add to
 * library", not "mark as played".) The "Out now" pill sits on the art, top-left, exactly where the
 * library card puts its countdown.
 */
function WishlistCard({
  game,
  now,
  onOpen,
  onComplete,
}: {
  readonly game: Game;
  readonly now: Date;
  readonly onOpen: (game: Game) => void;
  readonly onComplete: (game: Game) => void;
}): React.ReactElement {
  const dated = game.releaseDate !== null && game.releasePrecision !== null;
  const released = dated && isReleased(game.releaseDate, game.releasePrecision, now);
  const line = dated
    ? formatReleaseCountdown(game.releaseDate, game.releasePrecision, now)
    : 'No date';

  return (
    <div data-slot="wishlist-card" className="flex flex-col gap-2.5">
      <button
        type="button"
        aria-label={game.title}
        title={game.title}
        onClick={() => onOpen(game)}
        className="group focus-visible:ring-ring focus-visible:ring-offset-background relative aspect-3/4 w-full rounded-md text-left focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        <FoilCard tone="wishlist">
          <span className="bg-muted absolute inset-0 block">
            {game.coverUrl === null ? (
              <span
                className="flex h-full flex-col items-center justify-center gap-1.5"
                aria-hidden
              >
                <span className="text-muted-foreground/40 text-4xl font-semibold">
                  {game.title.trim().charAt(0).toUpperCase()}
                </span>
                <Gamepad2 className="text-muted-foreground/25 size-4" />
              </span>
            ) : (
              <Image
                src={game.coverUrl}
                alt=""
                fill
                sizes="(max-width: 640px) 50vw, (max-width: 1536px) 25vw, 300px"
                className="object-cover opacity-75"
              />
            )}
          </span>
          {released ? (
            <span className="absolute top-2 left-2 z-20 rounded-md bg-black/75 px-1.5 py-0.5 text-[0.6875rem] font-medium tracking-wide text-white uppercase">
              Out now
            </span>
          ) : null}
        </FoilCard>
      </button>

      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{game.title}</p>
        <p className="text-muted-foreground text-xs">
          {PLATFORM_LABELS[game.platform]} · {line}
        </p>
      </div>

      <Button
        size="sm"
        variant="outline"
        aria-label={`Add ${game.title} to library`}
        onClick={() => onComplete(game)}
      >
        Add to library
      </Button>
    </div>
  );
}
