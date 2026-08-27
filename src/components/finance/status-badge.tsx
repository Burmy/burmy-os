import { cn } from '@/lib/utils';

export type StatusTone = 'positive' | 'neutral' | 'attention' | 'muted';

const TONE_CLASSES: Record<StatusTone, string> = {
  positive: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-400',
  neutral: 'bg-secondary text-secondary-foreground',
  attention: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-400',
  muted: 'bg-muted text-muted-foreground',
};

/**
 * A small pill for row status — "Ready", "Needs attention", "Confirmed", and
 * so on. One shared shape so every table (import summary, review queue)
 * reads as the same visual language rather than each inventing its own.
 */
export function StatusBadge({
  tone,
  children,
}: {
  readonly tone: StatusTone;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        TONE_CLASSES[tone],
      )}
    >
      {children}
    </span>
  );
}
