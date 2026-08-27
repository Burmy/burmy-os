import { Trophy } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { TrophyTier } from '@/server/games/psn';
import { PlatinumBadge } from './platinum-badge';

/**
 * One row's tier marker in a per-game trophy list. `platinum` reuses
 * `PlatinumBadge` directly rather than a second "platinum-looking" element
 * — keeps this app's one deliberate gradient exception (see that
 * component's own doc comment) singular.
 *
 * Bronze/silver/gold get solid, theme-invariant colors — no gradient (the
 * gradient exception is platinum's alone), and deliberately NOT
 * `StatusBadge`'s theme-aware tint pattern either: a medal's color is a
 * fact about the trophy, not a UI accent that should shift with light/dark
 * theme any more than platinum's does. `rounded-md`, not `PlatinumBadge`'s
 * `rounded-md` medallion or a circle — smaller and quieter, since this sits
 * in a dense list of many rows rather than alone on a card corner.
 */
export function TrophyTierBadge({
  tier,
  className,
}: {
  readonly tier: TrophyTier;
  readonly className?: string;
}): React.ReactElement {
  if (tier === 'platinum') return <PlatinumBadge className={cn('size-6 rounded-md', className)} />;

  return (
    <span
      aria-hidden
      title={TIER_LABELS[tier]}
      className={cn('inline-flex size-6 items-center justify-center rounded-md ring-1', TIER_STYLES[tier], className)}
    >
      <Trophy className="size-3.5" strokeWidth={2.25} />
    </span>
  );
}

const TIER_LABELS: Record<Exclude<TrophyTier, 'platinum'>, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
};

const TIER_STYLES: Record<Exclude<TrophyTier, 'platinum'>, string> = {
  bronze: 'bg-amber-700 text-amber-50 ring-amber-900/40',
  silver: 'bg-slate-400 text-slate-900 ring-slate-500/40',
  gold: 'bg-yellow-500 text-yellow-950 ring-yellow-600/40',
};
