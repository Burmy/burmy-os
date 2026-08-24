'use client';

import Image from 'next/image';
import { Gamepad2 } from 'lucide-react';

import { PlatinumBadge } from '@/components/games/platinum-badge';
import { RatingStars } from '@/components/games/rating-stars';
import { StatusBadge } from '@/components/games/status-badge';
import { cn } from '@/lib/utils';
import type { Game } from '@/server/db/games/games';
import { PLATFORM_LABELS, STATUS_LABELS } from '@/server/games/taxonomy';
import { formatHours, hours } from '@/server/games/hours';

/**
 * One game in the gallery. Cover art is the primary affordance; everything else
 * is secondary metadata layered beneath it. Games with no cover fall back to a
 * tile that carries the title itself, rather than a bare icon floating in
 * empty space — roughly half the historical library predates cover art being
 * available at all, and a lone icon next to real box art elsewhere in the
 * grid reads as broken, not intentional. The title always renders in the
 * info panel below too, cover or not, so every card has identical structure
 * and a mixed grid never looks ragged.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STATUS BADGE LIVES AT THE BOTTOM OF THE COVER, NOT THE TOP.
 *
 * Portrait box art almost always carries the game's own logo/title treatment
 * across the top third of the cover — a badge pinned to the top-left corner
 * sat directly on top of it (reported: "Completed" over DISHONORED 2's own
 * logo, unreadable in both directions — the badge fought the art and the art
 * fought the badge). The bottom of a cover is far more often plain
 * background art, so the badge moves there instead, backed by `StatusBadge`'s
 * `variant="onImage"` (an opaque pill, legible against arbitrary art without
 * reaching for a gradient scrim — see that component for why).
 * ─────────────────────────────────────────────────────────────────────────────
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
      // status (plus platinum, when earned — the badge itself is
      // `aria-hidden` and this is its only accessible signal), and nothing
      // else from the card's remaining content.
      aria-label={`${game.title} — ${STATUS_LABELS[game.status]}${game.platinum ? ' — Platinum' : ''}`}
      onClick={() => onOpen(game)}
      className={cn(
        // NOT `overflow-hidden` on this element — a ring/box-shadow-based
        // focus indicator on the SAME element that clips its own content can
        // itself get clipped in some engines. The cover art below clips its
        // OWN corners on its own wrapper instead, so this element can stay
        // un-clipped and the focus ring always renders in full.
        'group flex flex-col rounded-lg border text-left',
        'transition-colors hover:border-foreground/20 hover:bg-muted/40',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
      )}
    >
      <div className="bg-muted relative aspect-[3/4] w-full overflow-hidden rounded-t-lg">
        {game.coverUrl === null ? (
          // A "letter tile" rather than a lone floating icon — the game's own
          // initial standing in for missing art, the same convention plenty
          // of apps use for a missing avatar/image. Deliberately NOT the full
          // title: it already renders in the info panel below (see the
          // "identical structure" note above), so repeating it here would
          // just be noise on the tile itself — and it's decorative
          // (`aria-hidden`), since the card's own `aria-label` already
          // carries the real title.
          <div className="flex h-full flex-col items-center justify-center gap-1.5" aria-hidden>
            <span className="text-muted-foreground/40 text-4xl font-semibold">
              {game.title.trim().charAt(0).toUpperCase()}
            </span>
            <Gamepad2 className="text-muted-foreground/25 size-4" />
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
        <div className="absolute inset-x-2 bottom-2 flex items-end justify-between gap-1.5">
          <StatusBadge status={game.status} variant="onImage" />
          {game.platinum ? <PlatinumBadge /> : null}
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-1 p-3">
        <span className="line-clamp-2 text-sm font-semibold">{game.title}</span>
        <span className="text-muted-foreground text-xs">
          {PLATFORM_LABELS[game.platform]}
          {game.firstPlayedYear === null ? '' : ` · ${game.firstPlayedYear}`}
          {/* Provenance, not platform — a `steam` PLATFORM game can still be
              unlinked (no sync match yet), and this is specifically "does
              Steam own this game's hours/achievements," the same signal
              game-dialog.tsx uses to disable those fields. */}
          {game.steamAppid === null ? '' : ' · Steam'}
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
