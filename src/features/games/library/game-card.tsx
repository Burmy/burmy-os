'use client';

import Image from 'next/image';
import { Gamepad2, Heart, Trophy } from 'lucide-react';

import { FoilCard } from '@/components/games/foil-card';
import { cn } from '@/lib/utils';
import type { Game } from '@/server/db/games/games';
import { STATUS_LABELS } from '@/server/games/taxonomy';

/**
 * One game in the gallery — THE COVER, AND NOTHING ELSE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO TEXT. NOT EVEN ON HOVER.
 *
 * This card has been cut down twice. It once carried eight competing things
 * (cover, status badge, platinum badge, title, platform, first-played year, a
 * Steam tag, a star rating and hours); that was reduced to cover + title + one
 * metadata line; real usage then asked for the rest to go too — "just the
 * cards."
 *
 * So the gallery is now a wall of box art with no text anywhere, including on
 * hover. That is a real trade and it was made deliberately: reading a title is
 * what TABLE view is for, and the Gallery/Table toggle sits in the filter row
 * two inches away. The gallery's job is recognition, not reading.
 *
 * Consequences worth knowing before "fixing" this:
 *   - `aria-label` is now the ONLY title a screen-reader user gets. It is not
 *     decorative and must not be trimmed.
 *   - `title` gives sighted users a native tooltip, which is the only recovery
 *     path for box art you don't recognise. Cheap, and worth keeping.
 *   - A game with no cover art falls back to a letter tile. It is genuinely
 *     weak — a single initial — but adding a title only there would make the
 *     grid inconsistent in exactly the way this change set out to fix.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PLATINUM AND WISHLIST ARE FOIL TREATMENTS, NOT BADGES-ON-ART.
 *
 * An earlier version painted a coloured badge over the box art (gold trophy,
 * violet heart) — "shitting colors and icons," and correctly so: third-party
 * art plus an app-coloured sticker never composes. The version after that used
 * a ring plus a raised card fill, which died with the padded box this card no
 * longer has.
 *
 * Now the whole card changes material, the way a foil trading card differs
 * from a normal one — see `foil-card.tsx` and the `@layer components` block in
 * `globals.css`. Platinum carries a restrained prismatic sheen that is faintly
 * visible AT REST (so 31 platinums are findable while scanning 180 cards) and
 * comes alive under the cursor. Wishlist gets cold, hueless frost instead:
 * different in kind, because an aspiration must not read as a prize.
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
      // Carries status and platinum even though neither renders as visible
      // text — with the card reduced to bare art this is the entire accessible
      // description of a grid item.
      aria-label={`${game.title} — ${STATUS_LABELS[game.status]}${game.platinum ? ' — Platinum' : ''}`}
      title={game.title}
      onClick={() => onOpen(game)}
      className="group relative aspect-3/4 w-full rounded-md text-left focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
    >
      <FoilCard tone={game.platinum ? 'platinum' : wishlisted ? 'wishlist' : null}>
        <span className="bg-muted absolute inset-0 block">
          {game.coverUrl === null ? (
            // A letter tile rather than a lone floating icon — the game's own
            // initial standing in for missing art, the convention plenty of
            // apps use for a missing avatar. Decorative: the button's own
            // `aria-label` and `title` carry the real name.
            <span className="flex h-full flex-col items-center justify-center gap-1.5" aria-hidden>
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
              className={cn('object-cover', wishlisted && 'opacity-75')}
            />
          )}
        </span>

        {/* One small monochrome glyph, bottom-right, over an opaque scrim so it
            stays legible against arbitrary box art without a gradient. Bottom
            rather than top: portrait box art almost always carries the game's
            own logo across the top third. z-20 keeps it above the foil layers
            (z-11/z-12), which would otherwise blend over it. */}
        {game.platinum ? (
          <span
            aria-hidden
            className="absolute right-2 bottom-2 z-20 inline-flex size-7 items-center justify-center rounded-full bg-black/70 text-slate-200 ring-1 ring-white/25"
          >
            <Trophy className="size-3.5" />
          </span>
        ) : wishlisted ? (
          <span
            aria-hidden
            className="absolute right-2 bottom-2 z-20 inline-flex size-7 items-center justify-center rounded-full bg-black/70 text-white/90 ring-1 ring-white/25"
          >
            <Heart className="size-3.5" />
          </span>
        ) : null}
      </FoilCard>
    </button>
  );
}
