'use client';

import Image from 'next/image';
import { Gamepad2, Heart, Trophy } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { Game } from '@/server/db/games/games';
import { PLATFORM_LABELS, STATUS_LABELS } from '@/server/games/taxonomy';
import { formatHours, hours } from '@/server/games/hours';

/**
 * One game in the gallery — COVER-FIRST.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS CARD DELIBERATELY DOES NOT SHOW.
 *
 * It used to carry eight competing things at once: cover, a status badge over
 * the art, a platinum badge, title, platform, first-played year, a "Steam"
 * provenance tag, a star rating and hours. Real usage called that "too
 * compact and way too much happening," and it was — at seven cards per row
 * none of it was legible anyway.
 *
 * What survives: the cover, the title, and ONE metadata line (platform +
 * hours). The year, the Steam tag, the star rating and the status badge are
 * all gone from the grid. Status stays reachable through the library's own
 * filter chips, and every dropped field is still on the game's own page —
 * this is a change to what the GRID advertises, not to what is tracked.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PLATINUM AND WISHLIST ARE CARD-LEVEL TREATMENTS, NOT BADGES-ON-ART.
 *
 * The old approach painted a colored badge on top of the box art (gold
 * trophy, violet heart), which is exactly the "shitting colors and icons"
 * the owner objected to — third-party art plus an app-colored sticker never
 * composes well.
 *
 * Instead the whole card changes character, the way a foil trading card
 * differs from a normal one: a metallic ring plus a raised fill. Silver is
 * NOT a new accent color in this system — platinum is literally a metal, and
 * the treatment stays monochrome, so it never competes with the app's one
 * red accent. Wishlist gets a deliberately DIFFERENT and quieter treatment:
 * it is an aspiration, not an achievement, so it must not read as a prize.
 *
 * Every card keeps the same padded box regardless of state, so the grid
 * stays aligned — only the FILL changes. A plain game's box is transparent,
 * which is what lets a treated card stand out at a glance.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function GameCard({
  game,
  onOpen,
}: {
  readonly game: Game;
  readonly onOpen: (game: Game) => void;
}): React.ReactElement {
  const wishlisted = game.status === 'wanted';

  return (
    <button
      type="button"
      // The accessible name still carries status and platinum even though
      // neither renders as visible text on the card any more — this is now
      // the ONLY status signal a screen-reader user tabbing the grid gets,
      // so it matters more than it did when a visible badge existed.
      aria-label={`${game.title} — ${STATUS_LABELS[game.status]}${game.platinum ? ' — Platinum' : ''}`}
      onClick={() => onOpen(game)}
      className={cn(
        'group flex flex-col gap-3 rounded-xl p-3 text-left transition-colors',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
        game.platinum
          ? 'bg-card ring-1 ring-slate-300 dark:ring-slate-400/35'
          : wishlisted
            ? 'bg-card/60'
            : 'hover:bg-card',
      )}
    >
      <div className="bg-muted relative aspect-[3/4] w-full overflow-hidden rounded-lg">
        {game.coverUrl === null ? (
          // A letter tile rather than a lone floating icon — the game's own
          // initial standing in for missing art, the convention plenty of
          // apps use for a missing avatar. Decorative: the button's own
          // `aria-label` already carries the real title.
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
            sizes="(max-width: 640px) 50vw, (max-width: 1280px) 25vw, 280px"
            className={cn('object-cover', wishlisted && 'opacity-75')}
          />
        )}

        {/* One small monochrome glyph, bottom-right, over an opaque scrim so
            it stays legible against arbitrary box art without a gradient.
            Bottom rather than top: portrait box art almost always carries
            the game's own logo across the top third. */}
        {game.platinum ? (
          <span
            aria-hidden
            title="Platinum"
            className="absolute right-2 bottom-2 inline-flex size-7 items-center justify-center rounded-full bg-black/70 text-slate-200 ring-1 ring-white/25"
          >
            <Trophy className="size-3.5" />
          </span>
        ) : wishlisted ? (
          <span
            aria-hidden
            title="On your wishlist"
            className="absolute right-2 bottom-2 inline-flex size-7 items-center justify-center rounded-full bg-black/70 text-white/90 ring-1 ring-white/25"
          >
            <Heart className="size-3.5" />
          </span>
        ) : null}
      </div>

      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{game.title}</div>
        <div className="text-muted-foreground mt-0.5 truncate text-xs">
          {PLATFORM_LABELS[game.platform]}
          {game.hoursTenths === null ? '' : ` · ${formatHours(hours(game.hoursTenths))}`}
        </div>
      </div>
    </button>
  );
}
