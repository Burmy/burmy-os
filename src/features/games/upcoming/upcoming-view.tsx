'use client';

import Image from 'next/image';
import Link from 'next/link';
import { Check, Gamepad2, Heart, Loader2, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { PageMeta } from '@/components/ui/page-meta';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { PLATFORM_LABELS } from '@/server/games/taxonomy';
import { MONTH_NAMES } from '@/server/games/upcoming';
import type { UpcomingMonth, UpcomingMonthGame } from '@/server/games/upcoming';
import { addToWishlistAction, promoteReleasedWantedGamesAction } from './wishlist-actions';

/**
 * `releaseDate` is always `YYYY-MM-01` (month precision only — IGDB's
 * month-precision rows carry no real day, see the type's own doc comment in
 * `upcoming.ts`) or `null` for the trailing Later/TBD bucket. Parsed from the
 * string parts directly, never via `new Date(...)`: a `Date` constructed
 * from a bare `YYYY-MM-DD` string is UTC-midnight, which can display as the
 * PREVIOUS day in a negative-UTC-offset timezone — the exact class of hazard
 * `upcoming.ts`'s own header comment already flags for raw IGDB dates.
 */
function formatReleaseMonth(releaseDate: string | null): string | null {
  if (releaseDate === null) return null;
  const [year, month] = releaseDate.split('-');
  const monthIndex = Number(month) - 1;
  return `${MONTH_NAMES[monthIndex]} ${year}`;
}

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
    <div className="space-y-8">
      <PageHeader title="Upcoming" />

      {/* IGDB's feed only ever surfaces titles with real pre-release hype in
          the next 12 months (see the module doc comment above) — a game
          that's already out, or never clears the hype floor, can never appear
          here no matter how long you wait, and the Library's Add Game flow
          has always accepted any hand-typed title with status Wanted.
          This survives the app-wide header-prose cull because it is not a
          description of the screen: it points at a path the owner genuinely
          cannot discover from here. It sits in `PageMeta` like every other
          live line rather than in the header. */}
      {igdbConfigured ? (
        <PageMeta>
          <span>
            Don&apos;t see a game here? IGDB only lists titles with real pre-release buzz, in the next 12 months. For
            anything else — already out, or below IGDB&apos;s radar — add it from the{' '}
            <Link href="/games/library" className="hover:text-foreground underline underline-offset-2">
              Library
            </Link>{' '}
            and set its status to Wanted.
          </span>
        </PageMeta>
      ) : null}

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
    <section className="space-y-4">
      <h2 className="text-sm font-semibold">{month.label}</h2>
      {month.games.length === 0 ? (
        <p className="text-muted-foreground text-sm">No anticipated releases this month.</p>
      ) : (
        // Same column counts and gap as the library grid (`game-grid.tsx`) —
        // the two used to diverge for no reason.
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
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
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WISHLISTED GETS A DISTINCT COVER TREATMENT, NOT JUST THE BUTTON AT THE BOTTOM.
 *
 * Before this, a wishlisted card and an un-wishlisted one were pixel-identical
 * above the fold — the ONLY difference was the "+ Add to wishlist" button
 * flipping to a disabled "Added" at the very bottom, invisible while scanning
 * a 7-column grid. A violet ring plus a small corner marker on the cover
 * itself make it scannable without reading any button — violet because
 * `StatusBadge` already uses it for the library's own `wanted` status, so
 * this reads as the SAME "wishlisted" meaning rather than a new color. The
 * marker sits at the BOTTOM corner, not top, for the same reason
 * `game-card.tsx` keeps its own badges off the top of the cover: box art
 * commonly carries a logo across the top third, and the bottom is far more
 * often plain background art. Stays CIRCULAR (unlike `PlatinumBadge`, which
 * moved to a rounded-square medallion) — the two never compete on the same
 * card (a wishlist candidate can't be platinum'd), so there was no "blurs
 * together" complaint to fix here; only size/contrast were raised, so this
 * got the same size-6→size-8, ring-1→ring-2, and a fully opaque background
 * bump `PlatinumBadge` got, without changing its shape.
 * ─────────────────────────────────────────────────────────────────────────────
 */
function UpcomingGameCard({
  game,
  wishlisted,
}: {
  readonly game: UpcomingMonthGame;
  readonly wishlisted: boolean;
}): React.ReactElement {
  const releaseMonth = formatReleaseMonth(game.releaseDate);

  return (
    <div
      className={cn(
        // Same card language as the library grid (`game-card.tsx`):
        // borderless, a padded box whose FILL carries the state, cover art
        // rounded on its own frame rather than the card's top corners.
        // The two grids used to diverge visually for no reason.
        'flex flex-col gap-3 rounded-xl p-3',
        wishlisted ? 'bg-card' : null,
      )}
    >
      <div className="bg-muted relative aspect-[3/4] w-full overflow-hidden rounded-lg">
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
        {/* Monochrome over an opaque scrim, matching the library's own
            badge treatment — the old violet pill was app-colored chrome
            sitting on third-party box art, which never composed well. */}
        {wishlisted ? (
          <span
            aria-hidden
            title="On your wishlist"
            className="absolute right-2 bottom-2 inline-flex size-7 items-center justify-center rounded-full bg-black/70 text-white/90 ring-1 ring-white/25"
          >
            <Heart className="size-3.5" />
          </span>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col gap-1">
        <span className="line-clamp-2 text-sm font-medium">{game.title}</span>
        <span className="text-muted-foreground text-xs">
          {game.platforms.map((platform) => PLATFORM_LABELS[platform]).join(' · ')}
        </span>
        {/* Month-precision only (see `formatReleaseMonth`'s own doc comment)
            — absent for the trailing Later/TBD bucket, where the section
            header already conveys "no known date" and repeating that per
            card would be redundant. */}
        {releaseMonth === null ? null : <span className="text-muted-foreground text-xs">{releaseMonth}</span>}
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
    // Not `disabled` — this is a permanent success/done state, not a
    // temporarily-unavailable control, so it must not pick up the shared
    // `disabled:opacity-50` rule in button.tsx: that rule fading an already
    // low-contrast `secondary` (gray-on-gray) pairing to half opacity is
    // exactly why "Added" was nearly illegible. `pointer-events-none` keeps
    // it inert without the HTML `disabled` attribute; `tabIndex={-1}` keeps
    // it out of tab order now that `disabled` no longer does that
    // automatically — there's nothing here for a keyboard user to activate.
    //
    // Monochrome, not the former emerald: this grid's whole card language
    // went black-and-white, and a green pill was the last colored chrome
    // left in it. Full-contrast foreground-on-muted reads as "done" without
    // needing a second semantic color.
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        tabIndex={-1}
        className="bg-muted text-foreground pointer-events-none w-full"
      >
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
