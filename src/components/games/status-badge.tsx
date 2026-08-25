import { cn } from '@/lib/utils';
import { STATUS_LABELS, type GameStatus } from '@/server/games/taxonomy';

/**
 * `played` MUST still be a key here — `Record<GameStatus, string>` demands
 * one entry per status, and that exhaustiveness is exactly what makes
 * typecheck fail loudly if a future status is ever added without updating
 * this map. The value itself is dead code: `StatusBadge` returns `null` for
 * `played` before either map is ever indexed into. Kept as the same emerald
 * tone `completed` used to carry, purely so a future reader who deletes the
 * early return by mistake gets back the old, correct-looking behavior rather
 * than an undefined class string.
 */
const STYLES: Record<GameStatus, string> = {
  backlog: 'bg-muted text-muted-foreground',
  playing: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  played: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  // Not owned yet — a wishlist entry, distinct from the three "in the
  // library" states above. Violet reads as neither "in progress" (blue) nor
  // "done" (emerald).
  wanted: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
};

/**
 * Same status→color mapping as `STYLES` above, reduced to a small solid dot
 * rather than a tinted pill background. Used only by `variant="onImage"`
 * below: a low-opacity tint assumes a neutral surface underneath it, and
 * against arbitrary box art it can wash out or vanish entirely (a `backlog`
 * badge in particular used to share its exact background color with the
 * placeholder tile it sat on). Fixed, theme-invariant colors — like
 * `PlatinumBadge` — because this badge sits on top of a photograph, not the
 * app's own surface, so it has nothing to do with which theme is active.
 */
const DOT_STYLES: Record<GameStatus, string> = {
  backlog: 'bg-slate-400',
  playing: 'bg-blue-400',
  // Dead code, same reasoning as `STYLES.played` above — `played` never
  // reaches this map at runtime.
  played: 'bg-emerald-400',
  wanted: 'bg-violet-400',
};

/**
 * Labels come from `taxonomy.ts`'s `STATUS_LABELS` — a private copy here
 * previously said "Paused" while taxonomy said "Paused / Dropped", so the
 * library's status filter chip and the badges it filters disagreed on screen.
 *
 * `variant="onImage"` exists for the library gallery card, where the badge is
 * painted directly over portrait box art rather than a plain background.
 * Box art commonly carries the game's own logo across the top of the cover,
 * so the card places this badge at the BOTTOM of the image instead (see
 * `game-card.tsx`) — but the bottom of a cover is still arbitrary
 * third-party art, so the default `STYLES` tint (designed for a neutral
 * surface) is not enough on its own. This variant swaps to an OPAQUE dark
 * pill, legible against any art without needing a gradient scrim (this
 * codebase's design brief — see `globals.css` — is deliberately
 * gradient-free), with the status color preserved as a small dot rather than
 * a background tint.
 */
export function StatusBadge({
  status,
  variant = 'default',
}: {
  readonly status: GameStatus;
  readonly variant?: 'default' | 'onImage';
}): React.ReactElement | null {
  // `played` is the invisible default — see `GAME_STATUSES` in taxonomy.ts.
  // A played game earns no badge in EITHER variant: that is the entire point
  // of the status, not an oversight to "fix" by giving it a muted style.
  if (status === 'played') return null;

  if (variant === 'onImage') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-black/75 px-2 py-0.5 text-xs font-medium text-white">
        <span className={cn('size-1.5 shrink-0 rounded-full', DOT_STYLES[status])} aria-hidden />
        {STATUS_LABELS[status]}
      </span>
    );
  }

  return (
    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STYLES[status])}>
      {STATUS_LABELS[status]}
    </span>
  );
}
