import { cn } from '@/lib/utils';
import { STATUS_LABELS, type GameStatus } from '@/server/games/taxonomy';

const STYLES: Record<GameStatus, string> = {
  backlog: 'bg-muted text-muted-foreground',
  playing: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  completed: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  paused_dropped: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
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
  completed: 'bg-emerald-400',
  paused_dropped: 'bg-amber-400',
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
}): React.ReactElement {
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
