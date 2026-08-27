'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import type { ActionResult } from '@/features/games/action-result';

/**
 * Per-field inline editing for the game page — click a value, it becomes a
 * real control, it saves itself independently of every other field. This
 * replaces the previous round's whole-page Edit/Save/Cancel toggle: real
 * usage found clicking "Edit" to change one field, then having to find and
 * click "Save" for the whole page, was the wrong model. Same underlying
 * idea as Finance's `InlineEditText`
 * (`src/components/finance/inline-edit-text.tsx`) — click, edit, blur
 * commits — generalized here to also cover selects and a checkbox, and to
 * call a Server Action directly instead of a per-row callback prop, since
 * there's no parent list state to update afterward: `onSave` already calls
 * `revalidatePath`, and Next refreshes this page's own Server Component
 * with the new value automatically. No local mirroring of "the current
 * value" is needed — `value` is always read straight from the fresh `game`
 * prop one level up.
 */

async function commit(onSave: (value: string) => Promise<ActionResult>, value: string): Promise<boolean> {
  const result = await onSave(value);
  if (!result.ok) {
    toast.error(result.error);
    return false;
  }
  return true;
}

export function InlineEditField({
  label,
  value,
  displayValue,
  placeholder = 'Not set',
  multiline = false,
  disabled = false,
  disabledHint,
  onSave,
}: {
  readonly label: string;
  readonly value: string;
  /** What to show when not editing, if nicer than the raw value (e.g. "22.1h" vs "22.1"). Defaults to `value`. */
  readonly displayValue?: React.ReactNode;
  readonly placeholder?: string;
  readonly multiline?: boolean;
  readonly disabled?: boolean;
  readonly disabledHint?: string;
  readonly onSave: (value: string) => Promise<ActionResult>;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);

  async function handleCommit(raw: string): Promise<void> {
    setEditing(false);
    const trimmed = raw.trim();
    if (trimmed === value) return;
    setPending(true);
    await commit(onSave, trimmed);
    setPending(false);
  }

  const Field = multiline ? Textarea : Input;

  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      {disabled ? (
        <span className="text-right">
          {displayValue ?? (value || placeholder)}
          {disabledHint === undefined ? null : (
            <span className="text-muted-foreground block text-xs">{disabledHint}</span>
          )}
        </span>
      ) : editing ? (
        <Field
          defaultValue={value}
          aria-label={label}
          autoFocus
          rows={multiline ? 3 : undefined}
          className={cn('h-8 max-w-56 text-right', multiline && 'h-auto max-w-full text-left')}
          onFocus={(event) => event.target.select()}
          onBlur={(event) => void handleCommit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !multiline) event.currentTarget.blur();
            if (event.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <button
          type="button"
          aria-label={label}
          onClick={() => setEditing(true)}
          disabled={pending}
          className={cn(
            'hover:text-foreground -my-1 max-w-full truncate rounded px-1 py-1 text-right transition-colors',
            value ? '' : 'text-muted-foreground italic',
          )}
        >
          {pending ? (
            <Loader2 className="ml-auto size-3.5 animate-spin" aria-hidden />
          ) : (
            (displayValue ?? (value || placeholder))
          )}
        </button>
      )}
    </div>
  );
}

export function InlineEditSelect({
  label,
  value,
  displayValue,
  placeholder = 'Not set',
  options,
  onSave,
}: {
  readonly label: string;
  /** The raw value passed to `onSave` and used to select the current option. */
  readonly value: string;
  /** What to show when not editing — usually a nicer label than `value` itself. */
  readonly displayValue: string;
  readonly placeholder?: string;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly onSave: (value: string) => Promise<ActionResult>;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);

  async function handleChange(next: string): Promise<void> {
    setEditing(false);
    if (next === value) return;
    setPending(true);
    await commit(onSave, next);
    setPending(false);
  }

  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      {editing ? (
        <Select
          defaultOpen
          value={value}
          onValueChange={(next) => void handleChange(next)}
          onOpenChange={(open) => {
            if (!open) setEditing(false);
          }}
        >
          <SelectTrigger size="sm" aria-label={label} className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <button
          type="button"
          aria-label={label}
          onClick={() => setEditing(true)}
          disabled={pending}
          className={cn(
            'hover:text-foreground -my-1 rounded px-1 py-1 text-right transition-colors',
            displayValue ? '' : 'text-muted-foreground italic',
          )}
        >
          {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : displayValue || placeholder}
        </button>
      )}
    </div>
  );
}
