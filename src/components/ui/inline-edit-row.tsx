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

/**
 * Per-field inline editing — click a value, it becomes a real control, it
 * saves itself independently of every other field. This replaced a whole-page
 * Edit/Save/Cancel toggle on the game page: real usage found that changing one
 * field, then hunting for a "Save" that committed the whole page, was the
 * wrong model. Same underlying idea as Finance's `InlineEditText`
 * (`src/components/finance/inline-edit-text.tsx`) — click, edit, blur commits
 * — generalized here to cover selects too, and to call a Server Action
 * directly instead of a per-row callback prop: `onSave` already calls
 * `revalidatePath`, and Next refreshes the calling Server Component with the
 * new value, so there is no parent list state to mirror.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS LIVED IN `src/features/games/game/` UNTIL ANIME NEEDED IT TOO.
 *
 * It has zero games imports and never had any — every prop is a string, a
 * label, or a callback. Promoting a proven primitive into `components/ui/` is
 * not the shared module framework CLAUDE.md forbids; a Games component
 * importing from `features/anime/` (or the reverse) is what that rule is
 * about, and this move is what makes it unnecessary.
 *
 * It declares its OWN minimal result type rather than importing one of the
 * six `action-result.ts` modules, for the same reason: a shared primitive that
 * imported a feature module's type would drag exactly the coupling the move
 * exists to avoid. Every one of those types is structurally assignable to this
 * one, so callers pass their own actions unchanged.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * The minimum an inline edit needs back: did it work, and if not, what to say.
 * Each module's own `ActionResult` satisfies this — Games' extra optional
 * `field` is simply ignored here.
 */
export type InlineEditResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

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
/**
 * `minmax(0,1fr)`, NOT `1fr` — and the difference is a real overflow bug, not
 * pedantry. A bare `1fr` track is `minmax(auto, 1fr)`, so its floor is the
 * content's own min-content width: a long unbreakable title ("Fullmetal
 * Alchemist: Brotherhood") pushes the track past its share, the `truncate` on
 * the value inside never engages because its container was never constrained,
 * and the whole page scrolls sideways. Measured on a 390px viewport, where an
 * anime show page ran to 422px until this was `minmax(0,1fr)`.
 *
 * Same family as the `min-w-0` rule CLAUDE.md records for flex chains — a grid
 * track and a flex item both default to an `auto` minimum, and both need the
 * override explicitly.
 */
export const ROW_CLASS = 'grid grid-cols-[9rem_minmax(0,1fr)] items-start gap-3 py-1.5 text-sm';

async function commit(
  onSave: (value: string) => Promise<InlineEditResult>,
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
  readonly onSave: (value: string) => Promise<InlineEditResult>;
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
  readonly onSave: (value: string) => Promise<InlineEditResult>;
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
