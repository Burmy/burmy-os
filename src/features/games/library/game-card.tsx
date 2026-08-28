'use client';

import Image from 'next/image';
import { Gamepad2, Heart, Loader2, Trophy } from 'lucide-react';

import { FoilCard } from '@/components/games/foil-card';
import { cn } from '@/lib/utils';
import type { Game } from '@/server/db/games/games';
import { formatReleaseCountdown } from '@/server/games/release-date';
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
 *
 * The ONE exception is the countdown on a wishlisted card, and it earns its
 * place: a wishlist entry is not a game you can recognise from its art and go
 * play, it is a date you are waiting on, and that date is the only reason the
 * row is in the library at all. It sits ON the art as a pill rather than under
 * the card, so the grid's rhythm is untouched and owned games stay wordless.
 *
 * The collection marker ("3 games") is the SECOND exception and earns its
 * place the same way. A collection's card looks exactly like any other card —
 * one cover, one title — while standing for three games the owner counts
 * separately, and nothing about the artwork says so. Without the marker the
 * gallery silently disagrees with the game count in the header two inches
 * above it. It reuses the countdown's pill and its corner, which can never
 * collide: a collection is never wishlisted (there is nothing inside a
 * collection you do not own).
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
  memberCount = 0,
  opening = false,
  onOpen,
}: {
  readonly game: Game;
  /** How many titles this row wraps. Non-zero exactly when it is a collection. */
  readonly memberCount?: number;
  /**
   * This card's navigation is in flight.
   *
   * The one piece of chrome allowed onto the art beyond the two documented
   * above, and it earns it for the opposite reason they do: it is not
   * information ABOUT the game, it is the card answering the click. Without it
   * a tap on a cover produced no change whatsoever until the next page
   * rendered, which in a wall of identical-looking tiles reads as a missed tap
   * — so the owner taps again. It is also strictly temporary, unlike the
   * countdown and the collection marker.
   */
  readonly opening?: boolean;
  readonly onOpen: (game: Game) => void;
}): React.ReactElement {
  const wishlisted = game.status === 'wanted';
  const collectionLabel =
    memberCount === 0 ? null : `${memberCount} game${memberCount === 1 ? '' : 's'}`;
  // Only a wishlisted game counts down, and only when IGDB actually gave a
  // date. `releasePrecision` is passed rather than assumed: a month-precision
  // row is stored as `YYYY-MM-01`, and reading that day as real would print
  // "in 3 days" for a game IGDB never claimed a launch day for.
  const countdown =
    wishlisted && game.releaseDate !== null && game.releasePrecision !== null
      ? formatReleaseCountdown(game.releaseDate, game.releasePrecision, new Date())
      : null;

  return (
    <button
      type="button"
      // Carries status and platinum even though neither renders as visible
      // text — with the card reduced to bare art this is the entire accessible
      // description of a grid item.
      aria-label={`${game.title} — ${STATUS_LABELS[game.status]}${game.platinum ? ' — Platinum' : ''}${collectionLabel === null ? '' : ` — collection of ${collectionLabel}`}`}
      title={game.title}
      onClick={() => onOpen(game)}
      aria-busy={opening || undefined}
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

        {/* The countdown, top-left — opposite corner from the glyph so the two
            can never collide, and top because portrait box art carries its
            logo across the top third, which a small pill sits over more
            gracefully than it sits over artwork. */}
        {countdown === null ? null : (
          <span className="absolute top-2 left-2 z-20 rounded-md bg-black/75 px-1.5 py-0.5 text-[0.6875rem] font-medium tracking-wide text-white uppercase">
            {countdown}
          </span>
        )}

        {/* Same pill, same corner as the countdown — see this file's header
            comment for why the two can never both be present. `aria-hidden`
            because the button's own `aria-label` already says it. */}
        {collectionLabel === null ? null : (
          <span
            aria-hidden
            className="absolute top-2 left-2 z-20 rounded-md bg-black/75 px-1.5 py-0.5 text-[0.6875rem] font-medium tracking-wide text-white uppercase"
          >
            {collectionLabel}
          </span>
        )}

        {/* A SOLID mark, not an outline in a black puck. The puck was there to
            keep a thin 14px outline legible against arbitrary box art, but it
            read as generic app chrome stuck onto someone else's artwork. A
            filled shape with a drop-shadow carries at this size on its own —
            the silhouette does the work the container was doing, and there is
            less of the app sitting on top of the cover.

            Bottom-right: see the countdown's comment above. z-20 keeps it over
            the foil layers (z-11/z-12), which would otherwise blend into it. */}
        {game.platinum ? (
          <span
            aria-hidden
            className="absolute right-2 bottom-2 z-20 text-slate-100 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]"
          >
            <Trophy className="size-5" fill="currentColor" strokeWidth={1.5} />
          </span>
        ) : wishlisted ? (
          <span
            aria-hidden
            className="absolute right-2 bottom-2 z-20 text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]"
          >
            <Heart className="size-5" fill="currentColor" strokeWidth={1.5} />
          </span>
        ) : null}
        {/* Above every foil layer (z-11/z-12) and both corner marks (z-20),
            because while it is showing it is the only thing that matters. */}
        {opening ? (
          <span className="absolute inset-0 z-30 flex items-center justify-center bg-black/40" aria-hidden>
            <Loader2 className="size-6 animate-spin text-white" />
          </span>
        ) : null}
      </FoilCard>
    </button>
  );
}
