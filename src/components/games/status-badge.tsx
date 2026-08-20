import { cn } from '@/lib/utils';
import { STATUS_LABELS, type GameStatus } from '@/server/games/taxonomy';

const STYLES: Record<GameStatus, string> = {
  backlog: 'bg-muted text-muted-foreground',
  playing: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  completed: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  paused_dropped: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
};

// Labels come from `taxonomy.ts`'s `STATUS_LABELS` — a private copy here
// previously said "Paused" while taxonomy said "Paused / Dropped", so the
// library's status filter chip and the badges it filters disagreed on screen.
export function StatusBadge({ status }: { readonly status: GameStatus }): React.ReactElement {
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STYLES[status])}>
      {STATUS_LABELS[status]}
    </span>
  );
}
