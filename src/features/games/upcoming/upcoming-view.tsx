'use client';

import Image from 'next/image';
import { Check, Gamepad2, Loader2, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { PLATFORM_LABELS } from '@/server/games/taxonomy';
import type { UpcomingMonth, UpcomingMonthGame } from '@/server/games/upcoming';
import { addToWishlistAction, promoteReleasedWantedGamesAction } from './wishlist-actions';

/**
 * The "Upcoming games" tab: IGDB's PS5/PC releases over the next 12 months
 * (`HYPE_FLOOR = 30` — see `igdb.ts`), grouped by month with a trailing
 * Later/TBD bucket for anything IGDB only knows the year/quarter of.
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
 *      months above the hype floor, or a request that failed after
 *      credentials passed the check above. Neither this component nor the
 *      page has enough information to tell those apart, so the copy says so
 *      rather than asserting a cause it doesn't know.
 *   3. "A month rendered, but has no games" — defensive: `groupByMonth`
 *      never actually produces an empty bucket in real use (a bucket only
 *      exists because at least one game landed in it), but `MonthSection`
 *      takes `UpcomingMonth` as plain data, not a value it can assume its
 *      only real caller's invariants hold for, so it handles the empty case
 *      honestly rather than rendering an empty grid.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function UpcomingView({
  months,
  wishlistedIgdbIds,
  overdueWantedCount,
  igdbConfigured,
}: {
  readonly months: readonly UpcomingMonth[];
  /** The owner's existing `igdb_id`s — already-wishlisted (or since-owned) candidates render "Added", not the add control. */
  readonly wishlistedIgdbIds: readonly number[];
  /** How many `wanted` rows are already overdue, computed by the server page — see the mount effect below. */
  readonly overdueWantedCount: number;
  readonly igdbConfigured: boolean;
}): React.ReactElement {
  const wishlisted = useMemo(() => new Set(wishlistedIgdbIds), [wishlistedIgdbIds]);

  // Captured once, at mount, in a ref rather than read from the prop
  // directly inside the effect: the intent is "fire once, only for the
  // count the SERVER computed for this page load," not "re-fire whenever
  // this prop happens to change" — a ref sidesteps needing `overdueWantedCount`
  // in the dependency array at all, the same idiom `game-dialog.tsx` uses
  // for its own "only once, on a real edit" guards (`titleEditedRef`).
  const overdueWantedCountRef = useRef(overdueWantedCount);

  useEffect(() => {
    if (overdueWantedCountRef.current <= 0) return;
    // Fire-and-forget: a failed auto-flip just means the overdue rows stay
    // `wanted` until the next visit tries again — not worth surfacing to
    // the owner as an error for a background bookkeeping action they never
    // asked to run in the first place (see the action's own doc comment).
    promoteReleasedWantedGamesAction().catch(() => {});
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Upcoming</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Anticipated PS5 and PC releases over the next 12 months.
        </p>
      </div>

      {!igdbConfigured ? (
        <p className="text-muted-foreground py-16 text-center text-sm text-balance">
          Upcoming games needs IGDB credentials. Set <code className="font-mono">IGDB_CLIENT_ID</code> and{' '}
          <code className="font-mono">IGDB_CLIENT_SECRET</code> to enable this tab.
        </p>
      ) : months.length === 0 ? (
        <p className="text-muted-foreground py-16 text-center text-sm text-balance">
          No upcoming games to show right now — either nothing in the next 12 months clears the hype threshold, or
          IGDB couldn&apos;t be reached. Try again later.
        </p>
      ) : (
        <div className="space-y-8">
          {months.map((month) => (
            <MonthSection key={month.key} month={month} wishlisted={wishlisted} />
          ))}
        </div>
      )}
    </div>
  );
}

function MonthSection({
  month,
  wishlisted,
}: {
  readonly month: UpcomingMonth;
  readonly wishlisted: ReadonlySet<number>;
}): React.ReactElement {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">{month.label}</h2>
      {month.games.length === 0 ? (
        <p className="text-muted-foreground text-sm">No anticipated releases this month.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
          {month.games.map((game) => (
            <UpcomingGameCard key={game.igdbId} game={game} wishlisted={wishlisted.has(game.igdbId)} />
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
 */
function UpcomingGameCard({
  game,
  wishlisted,
}: {
  readonly game: UpcomingMonthGame;
  readonly wishlisted: boolean;
}): React.ReactElement {
  return (
    <div className="flex flex-col rounded-lg border">
      <div className="bg-muted relative aspect-[3/4] w-full overflow-hidden rounded-t-lg">
        {game.coverUrl === null ? (
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
            className="object-cover"
          />
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1 p-3">
        <span className="line-clamp-2 text-sm font-semibold">{game.title}</span>
        <span className="text-muted-foreground text-xs">
          {game.platforms.map((platform) => PLATFORM_LABELS[platform]).join(' · ')}
        </span>
        <div className="mt-auto pt-2">
          <AddToWishlistButton game={game} wishlisted={wishlisted} />
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
 * is about to do.
 */
function AddToWishlistButton({
  game,
  wishlisted,
}: {
  readonly game: UpcomingMonthGame;
  readonly wishlisted: boolean;
}): React.ReactElement {
  const [added, setAdded] = useState(false);
  const [pending, startTransition] = useTransition();

  const isAdded = wishlisted || added;

  function add(): void {
    startTransition(async () => {
      const result = await addToWishlistAction({
        igdbId: game.igdbId,
        title: game.title,
        coverUrl: game.coverUrl,
        releaseDate: game.releaseDate,
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

  if (isAdded) {
    return (
      <Button size="sm" variant="secondary" disabled className="w-full">
        <Check className="size-4" aria-hidden />
        Added
      </Button>
    );
  }

  return (
    <Button size="sm" variant="outline" onClick={add} disabled={pending} className="w-full">
      {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
      {pending ? 'Adding…' : 'Add to wishlist'}
    </Button>
  );
}
