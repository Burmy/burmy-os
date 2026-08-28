'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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

/**
 * One label/value row.
 *
 * A FIXED LABEL COLUMN, not `justify-between`. These rows used to push the
 * label hard left and the value hard right across the whole column — which is
 * fine at 400px and unreadable at 1170px, where "Ownership" and "Physical"
 * ended up most of a screen apart with nothing connecting them. Real usage
 * reported exactly that: "the info heading and info too far apart so i can't
 * really tell."
 *
 * A 9rem label column with the value immediately beside it means the eye
 * makes one short hop instead of scanning a full-width run. It also removes
 * the reason the old layout needed a rule under every row to bind the pair
 * together — see `game-view-content.tsx`, which dropped `divide-y` in the
 * same change.
 */
export const ROW_CLASS = 'grid grid-cols-[9rem_1fr] items-start gap-3 py-1.5 text-sm';

async function commit(
  onSave: (value: string) => Promise<ActionResult>,
  value: string,
): Promise<boolean> {
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
  hint,
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
  /**
   * A note shown under an EDITABLE value — `disabledHint` only renders when
   * the field is read-only, which is the wrong shape for "this number is real
   * but means something narrower than the label suggests".
   */
  readonly hint?: string;
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
    <div className={ROW_CLASS}>
      <span className="text-muted-foreground">{label}</span>
      {disabled ? (
        <span>
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
          className={cn('h-8 max-w-56', multiline && 'h-auto max-w-full')}
          onFocus={(event) => event.target.select()}
          onBlur={(event) => void handleCommit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !multiline) event.currentTarget.blur();
            if (event.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <span>
          <button
            type="button"
            aria-label={label}
            onClick={() => setEditing(true)}
            disabled={pending}
            className={cn(
              'hover:text-foreground -mx-1 -my-1 max-w-full truncate rounded-md px-1 py-1 text-left transition-colors',
              value ? '' : 'text-muted-foreground italic',
            )}
          >
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              (displayValue ?? (value || placeholder))
            )}
          </button>
          {hint === undefined ? null : (
            <span className="text-muted-foreground block text-xs">{hint}</span>
          )}
        </span>
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
  disabled = false,
  disabledHint,
  onSave,
}: {
  readonly label: string;
  /** The raw value passed to `onSave` and used to select the current option. */
  readonly value: string;
  /** What to show when not editing — usually a nicer label than `value` itself. */
  readonly displayValue: string;
  readonly placeholder?: string;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  /** Read-only, because the value is owned somewhere else (a Steam link, a collection). Mirrors `InlineEditField`. */
  readonly disabled?: boolean;
  readonly disabledHint?: string;
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
    <div className={cn(ROW_CLASS, 'items-center')}>
      <span className="text-muted-foreground">{label}</span>
      {disabled ? (
        <span>
          {displayValue || placeholder}
          {disabledHint === undefined ? null : (
            <span className="text-muted-foreground block text-xs">{disabledHint}</span>
          )}
        </span>
      ) : editing ? (
        <Select
          defaultOpen
          value={value}
          onValueChange={(next) => void handleChange(next)}
          onOpenChange={(open) => {
            if (!open) setEditing(false);
          }}
        >
          <SelectTrigger size="sm" aria-label={label} className="h-8 w-full max-w-56">
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
            'hover:text-foreground -mx-1 -my-1 w-fit max-w-full truncate rounded-md px-1 py-1 text-left transition-colors',
            displayValue ? '' : 'text-muted-foreground italic',
          )}
        >
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            displayValue || placeholder
          )}
        </button>
      )}
    </div>
  );
}
