'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * A small group of mutually-exclusive options rendered as one joined
 * control — Games' gallery/table view switch and Finance's Month/This Year
 * switch, which were the same thing built twice with different markup and
 * different heights.
 *
 * Options can be icon-only (pass `icon` + `label`, where the label becomes
 * the accessible name) or text (`label` renders visibly). `aria-pressed`
 * carries the state, matching what both hand-rolled versions already did.
 */
export function SegmentedToggle<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly options: readonly {
    readonly value: T;
    readonly label: string;
    readonly icon?: React.ReactNode;
  }[];
  readonly className?: string;
}): React.ReactElement {
  return (
    <div className={cn('bg-card inline-flex rounded-md p-1', className)}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Button
            key={option.value}
            type="button"
            variant={active ? 'secondary' : 'ghost'}
            aria-label={option.icon ? option.label : undefined}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
          >
            {option.icon ?? option.label}
          </Button>
        );
      })}
    </div>
  );
}
