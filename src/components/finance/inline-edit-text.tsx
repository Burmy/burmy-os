'use client';

import { useState } from 'react';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Plain text until clicked, then an input — for merchant names and notes on
 * a row-dense table (import review, the ledger, the Monthly drill-down). An
 * always-visible bordered input on every row of every column reads as
 * cluttered at any real row count; showing the value as text and only
 * switching to an editable control on demand keeps the common case (reading)
 * uncluttered without losing the edit affordance.
 *
 * Uncontrolled by design, matching the plain `<Input defaultValue>` pattern
 * already used everywhere else edits happen in this app: `onSave` fires
 * once, on blur or Enter, not on every keystroke.
 */
export function InlineEditText({
  value,
  onSave,
  placeholder = '—',
  ariaLabel,
  className,
}: {
  readonly value: string;
  readonly onSave: (value: string) => void;
  readonly placeholder?: string;
  readonly ariaLabel: string;
  readonly className?: string;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);

  function commit(raw: string): void {
    setEditing(false);
    const trimmed = raw.trim();
    if (trimmed !== value) onSave(trimmed);
  }

  if (editing) {
    return (
      <Input
        defaultValue={value}
        aria-label={ariaLabel}
        autoFocus
        className={cn('h-8', className)}
        onFocus={(event) => event.target.select()}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          // Escape discards without saving — handled by simply leaving
          // `commit` uncalled and dropping back to the last saved `value`.
          if (event.key === 'Escape') setEditing(false);
        }}
      />
    );
  }

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={() => setEditing(true)}
      title={value || undefined}
      className={cn(
        'hover:bg-muted/50 -mx-1 block max-w-full truncate rounded-md px-1 py-1 text-left text-sm',
        value ? '' : 'text-muted-foreground italic',
        className,
      )}
    >
      {value || placeholder}
    </button>
  );
}
