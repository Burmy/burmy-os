'use client';

import Image from 'next/image';
import Link from 'next/link';
import { Check, Gamepad2, Loader2, Plus } from 'lucide-react';
import { useEffect, useRef, useState, useTransition } from 'react';

import { FoilCard } from '@/components/games/foil-card';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { toast } from '@/components/ui/toast';
import type { Game } from '@/server/db/games/games';
import { formatReleaseCountdown } from '@/server/games/release-date';
import { PLATFORM_LABELS } from '@/server/games/taxonomy';
import type { UpcomingMonth, UpcomingMonthGame } from '@/server/games/upcoming';
import { addToWishlistAction, reconcileWishlistReleaseDatesAction } from './wishlist-actions';
import { WishlistSection } from './wishlist-section';

/**
 * The card's release line. `null` for the trailing Later/TBD bucket, where
 * there is no date to show at all.
 *
 * This used to print the month unconditionally, because every stored date was
 * `YYYY-MM-01` — IGDB's day was available and simply never requested. Now that
 * `release_dates.d` is in the query, a `date_format` 0 game has a real day and
 * gets a real countdown; a month-precision game still says "November 2026",
 * because IGDB genuinely does not know more than that.
 *
 * `formatReleaseCountdown` parses the string parts directly rather than via
 * `new Date(...)`: a `Date` built from a bare `YYYY-MM-DD` is UTC-midnight and
 * can display as the PREVIOUS day in a negative-UTC-offset timezone — the exact
 * hazard `upcoming.ts`'s header comment already flags for raw IGDB dates.
 */
function formatReleaseLine(game: UpcomingMonthGame, now: Date): string | null {
  if (game.releaseDate === null || game.releasePrecision === null) return null;
  return formatReleaseCountdown(game.releaseDate, game.releasePrecision, now);
}

/**
 * The "Upcoming" tab: the owner's own wishlist first, then IGDB's PS5/PC
 * releases over the next 12 months (`HYPE_FLOOR = 30` — see `igdb.ts`),
 * grouped by month with a trailing Later/TBD bucket for anything IGDB only
 * knows the year/quarter of. Anything already in the library is filtered
 * out of the feed by the page (`excludeOwned`) — it is in the wishlist
 * section instead, or owned outright.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE EMPTY STATES, EACH A DIFFERENT QUESTION
 *
 *   1. "Is IGDB even configured?" — answered server-side, directly against
 *      `process.env` (`igdbConfigured` prop), independent of the fetch that
 *      produced `months`. `fetchUpcomingGames()` returns `[]` on missing
 *      credentials exactly like it does on a failed request, so THIS is the
 *      only reliable signal for "not configured" — see `igdbConfigured()`'s
 *      own doc comment in `igdb.ts`.
 *   2. "IGDB is configured, but nothing came back" (`months.length === 0`)
 *      — deliberately vague about WHY: it could be a genuinely quiet 12
 *      months above the hype floor, a feed the owner has already wishlisted
 *      in full, or a request that failed after credentials passed the check
 *      above. Neither this component nor the page has enough information to
 *      tell those apart, so the copy says so rather than asserting a cause.
 *   3. "A month rendered, but has no games" — defensive: `groupByMonth`
 *      never actually produces an empty bucket in real use, and `excludeOwned`
 *      drops any it empties, but `MonthSection` takes `UpcomingMonth` as plain
 *      data, not a value it can assume its only real caller's invariants hold
 *      for, so it handles the empty case honestly rather than rendering an
 *      empty grid.
 *
 * The wishlist section renders in every one of those states — it is the
 * owner's own data and needs no IGDB at all.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function UpcomingView({
  months,
  wishlist,
  igdbConfigured,
}: {
  readonly months: readonly UpcomingMonth[];
  /** Every `wanted` game the owner has — IGDB-sourced or hand-added. */
  readonly wishlist: readonly Game[];
  readonly igdbConfigured: boolean;
}): React.ReactElement {
  // Captured at mount in a ref: this is "reconcile against what the SERVER
  // sent for this page load," not "re-reconcile whenever `months` arrives as a
  // new array reference." A ref also keeps the flattening out of render.
  const monthsRef = useRef(months);

  useEffect(() => {
    // Only games actually rendered, and only ones IGDB gave a real date for.
    // This is half the safety story for the reconcile: a missing credential
    // and a failed request both produce an empty feed (see `igdbConfigured()`),
    // which lands here as an empty list the action treats as "nothing to say"
    // rather than "every stored date is now null."
    const readings = monthsRef.current.flatMap((month) =>
      month.games.flatMap((game) =>
        game.releaseDate === null || game.releasePrecision === null
          ? []
          : [
              {
                igdbId: game.igdbId,
                releaseDate: game.releaseDate,
                releasePrecision: game.releasePrecision,
              },
            ],
      ),
    );
    if (readings.length === 0) return;

    // Fire-and-forget: stale wishlist dates until the next visit are not
    // worth an error toast for work the owner never asked to run.
    reconcileWishlistReleaseDatesAction(readings).catch(() => {});
  }, []);

  return (
    <div className="space-y-8">
      <PageHeader title="Upcoming" />

      <WishlistSection games={wishlist} />

      {!igdbConfigured ? (
        <p className="text-muted-foreground py-16 text-center text-sm text-balance">
          Upcoming games needs IGDB credentials. Set{' '}
          <code className="font-mono">IGDB_CLIENT_ID</code> and{' '}
          <code className="font-mono">IGDB_CLIENT_SECRET</code> to enable the release feed.
        </p>
      ) : months.length === 0 ? (
        <p className="text-muted-foreground py-16 text-center text-sm text-balance">
          No upcoming games to show right now — either nothing in the next 12 months clears the hype
          threshold, everything that does is already on your wishlist, or IGDB couldn&apos;t be
          reached. Try again later.
        </p>
      ) : (
        <div className="space-y-8">
          {months.map((month) => (
            <MonthSection key={month.key} month={month} />
          ))}
        </div>
      )}

      {/* A FOOTNOTE, not a description — so it sits at the bottom rather than
          pushing the actual content down on every visit. IGDB's feed only
          carries titles with real pre-release hype in the next 12 months, so a
          game below the hype floor never appears there no matter how long you
          wait; the Library's Add game flow takes a hand-typed title with
          status Wanted, and it then shows in Your wishlist above. */}
      {igdbConfigured ? (
        <p className="text-muted-foreground border-t pt-6 text-xs">
          Don&apos;t see a game in the feed? IGDB only lists titles with real pre-release buzz, in
          the next 12 months. For anything else, add it from the{' '}
          <Link
            href="/games/library"
            className="hover:text-foreground underline underline-offset-2"
          >
            Library
          </Link>{' '}
          with its status set to Wanted and it appears in Your wishlist above — with a countdown
          once you give it a release date.
        </p>
      ) : null}
    </div>
  );
}

function MonthSection({ month }: { readonly month: UpcomingMonth }): React.ReactElement {
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold">{month.label}</h2>
      {month.games.length === 0 ? (
        <p className="text-muted-foreground text-sm">No anticipated releases this month.</p>
      ) : (
        // Same column counts and gap as the library grid (`game-grid.tsx`) —
        // the two used to diverge for no reason.
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
          {month.games.map((game) => (
            <UpcomingGameCard key={game.igdbId} game={game} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * One candidate. Cover + letter-tile-fallback idiom mirrors
 * `library/game-card.tsx` exactly (same aspect ratio, same "initial
 * standing in for missing art" reasoning) — IGDB has no cover for every
 * upcoming title either, and a lone floating icon would look just as broken
 * here as it would in the library gallery.
 *
 * A card here is never already-wishlisted: the page filters those out of the
 * feed, since they are listed in "Your wishlist" above. The only state the
 * card carries is the moment after the owner clicks Add, before the page
 * re-renders without it.
 */
function UpcomingGameCard({ game }: { readonly game: UpcomingMonthGame }): React.ReactElement {
  // Read once per render rather than per card: every card in the grid must
  // count down from the same instant, and a `new Date()` inside each one is
  // both wasteful and capable of straddling midnight mid-render.
  const releaseLine = formatReleaseLine(game, new Date());

  return (
    <div
      // `data-slot` is this codebase's existing hook convention (every
      // shadcn primitive carries one). Tests reach the card through it
      // rather than a radius class — a radius is styling that moves.
      data-slot="upcoming-card"
      className="flex flex-col gap-2.5"
    >
      {/* Same cover treatment as the library grid — tilt and glare on every
          card. These two galleries share one card language and must not
          diverge again; see `foil-card.tsx`. What they do NOT share is the
          text below: this screen still needs the title, the release month
          and the add control, because a card here is something you act on
          rather than something you recognise. */}
      <div className="relative aspect-3/4 w-full">
        <FoilCard tone={null}>
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
                className="object-cover"
              />
            )}
          </span>
        </FoilCard>
      </div>

      <div className="flex flex-1 flex-col gap-1">
        <span className="line-clamp-2 text-sm font-medium">{game.title}</span>
        <span className="text-muted-foreground text-xs">
          {game.platforms.map((platform) => PLATFORM_LABELS[platform]).join(' · ')}
        </span>
        {/* Absent for the trailing Later/TBD bucket, where the section header
            already conveys "no known date" and repeating that per card would
            be redundant. */}
        {releaseLine === null ? null : (
          <span className="text-muted-foreground text-xs">{releaseLine}</span>
        )}
        <div className="mt-auto pt-2">
          <AddToWishlistButton game={game} />
        </div>
      </div>
    </div>
  );
}

/**
 * NOT `useOptimistic` — this codebase has a documented bug class where an
 * assertion (and, here, the rendered "Added" state) passed on optimistic
 * state before the server write had actually landed. `added` is only ever
 * set to `true` AFTER `addToWishlistAction` resolves `ok: true`, so this
 * always reflects what the server actually did, never a guess about what it
 * is about to do. The action's own `revalidatePath` then re-renders the
 * page, which moves the game up into "Your wishlist".
 */
function AddToWishlistButton({ game }: { readonly game: UpcomingMonthGame }): React.ReactElement {
  const [added, setAdded] = useState(false);
  const [pending, startTransition] = useTransition();

  function add(): void {
    startTransition(async () => {
      const result = await addToWishlistAction({
        igdbId: game.igdbId,
        title: game.title,
        coverUrl: game.coverUrl,
        releaseDate: game.releaseDate,
        releasePrecision: game.releasePrecision,
        platforms: game.platforms,
      });

      if (result.ok) {
        setAdded(true);
        toast.success(`${game.title} added to your wishlist`);
        return;
      }
      toast.error(result.error);
    });
  }

  if (added) {
    // Not `disabled` — this is a permanent success/done state, not a
    // temporarily-unavailable control, so it must not pick up the shared
    // `disabled:opacity-50` rule in button.tsx. `pointer-events-none` keeps
    // it inert without the HTML `disabled` attribute; `tabIndex={-1}` keeps
    // it out of tab order — there's nothing here for a keyboard user to do.
    return (
      <Button type="button" size="sm" tabIndex={-1} className="pointer-events-none w-full">
        <Check className="size-4" aria-hidden />
        Added
      </Button>
    );
  }

  return (
    <Button size="sm" variant="outline" onClick={add} disabled={pending} className="w-full">
      {pending ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <Plus className="size-4" aria-hidden />
      )}
      {pending ? 'Adding…' : 'Add to wishlist'}
    </Button>
  );
}
