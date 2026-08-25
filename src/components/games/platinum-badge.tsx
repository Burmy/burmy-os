import { Trophy } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * The platinum trophy marker — the owner's own claim, not third-party data
 * (see `games.platinum` in the schema). Deliberately NOT built from the same
 * palette as `StatusBadge` (blue/muted/violet — `played` renders no badge at
 * all): a platinum is an achievement worth showing off, so this reaches for
 * a metallic
 * platinum/silver register instead of another flat color pill, and its round
 * shape keeps it from reading as "one more status" stacked next to the real
 * status badge.
 *
 * Icon-only by design — the surrounding card supplies the accessible name via
 * its own `aria-label` (title + status + platinum), so this is `aria-hidden`
 * to avoid a redundant, unlabeled announcement.
 */
export function PlatinumBadge({ className }: { readonly className?: string }): React.ReactElement {
  return (
    <span
      aria-hidden
      title="Platinum"
      className={cn(
        'inline-flex size-6 items-center justify-center rounded-full',
        'bg-gradient-to-br from-slate-100 via-slate-300 to-slate-400 text-slate-700 shadow-sm ring-1 ring-slate-400/50',
        'dark:from-slate-200 dark:via-slate-300 dark:to-slate-400 dark:text-slate-800',
        className,
      )}
    >
      <Trophy className="size-3.5" strokeWidth={2.25} />
    </span>
  );
}
