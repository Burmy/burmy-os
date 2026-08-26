'use client';

import { useState } from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

/**
 * Shared small form-field wrappers used by both the create-only Add Game
 * dialog (`library/game-dialog.tsx`) and the per-game edit page
 * (`game/game-page.tsx`) — moved here from `game-dialog.tsx` once a second
 * consumer needed them, rather than duplicated.
 */

export function Field({
  id,
  label,
  defaultValue,
  value,
  onChange,
  placeholder,
  disabled,
  hint,
}: {
  readonly id: string;
  readonly label: string;
  readonly defaultValue?: string | number;
  readonly value?: string;
  readonly onChange?: (value: string) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  /**
   * A short provenance note rendered beside the input — e.g. "From Steam" for
   * a field a linked game's sync run owns. `string | null` rather than the
   * usual `string | undefined` so callers can pass the field's live
   * "do I have a hint right now" state directly (`hint={cond ? 'x' : null}`)
   * without an extra conditional spread just to dodge
   * `exactOptionalPropertyTypes`.
   */
  readonly hint?: string | null;
}): React.ReactElement {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={id}
        {...(value === undefined ? { defaultValue } : { value, onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange?.(e.target.value) })}
        {...(placeholder === undefined ? {} : { placeholder })}
        disabled={disabled}
      />
      {hint == null ? null : <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

export function FieldSelect({
  id,
  label,
  value,
  onChange,
  options,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: ReadonlyArray<{ value: string; label: string }>;
}): React.ReactElement {
  return (
    <div className="space-y-2">
      <Label htmlFor={`${id}-trigger`}>{label}</Label>
      {/* Radix Select does not post a native form value — the parent form sets it on FormData before submit. */}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={`${id}-trigger`}>
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
    </div>
  );
}

/**
 * Plain text until clicked, then a real input — for Genre/Developer/
 * Publisher, which are almost always filled by an IGDB pick and rarely
 * hand-edited. Three permanently-open input boxes for fields that are read
 * far more than they're typed into is exactly the density this control was
 * built to cut. Deliberately NOT Finance's `InlineEditText`
 * (`src/components/finance/inline-edit-text.tsx`): that component commits
 * via an `onSave` callback fired once on blur, fitting Finance's row-dense
 * tables where each row saves independently through its own Server Action.
 * The Add Game dialog and the game edit page have no such per-field save —
 * every field reaches the server together through ONE native form submit —
 * so this needs `value`/`onChange` wired into the same controlled state
 * `genre`/`developer`/`publisher` already use for IGDB auto-fill, not a
 * fire-and-forget save.
 *
 * The hidden input is what actually reaches `FormData` — it always mirrors
 * the current value, mounted at all times, regardless of whether the owner
 * is looking at the button or the input. Toggling `editing` only changes
 * which VISIBLE control has focus, never whether the value is submitted;
 * this is the same "never let a field go missing from the DOM at submit
 * time" rule both callers' own `submit()` and any `Tabs` `forceMount`
 * wrapping this are built around.
 *
 * `data-inline-field-editing` is read by the Add Game dialog's
 * `DialogContent`'s `onEscapeKeyDown` (Radix's Dialog dismisses on Escape
 * via a document-level capture listener that a bubble-phase
 * `stopPropagation()` here cannot prevent — see that dialog's own comment).
 * It's inert on the edit page, which has no enclosing Radix dismissable
 * layer to fight with — left in rather than forked or prop-gated, since a
 * single shared component correct in both contexts is worth more than
 * trimming three harmless lines.
 */
export function InlineField({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <input type="hidden" name={id} value={value} readOnly />
      {editing ? (
        <Input
          id={id}
          defaultValue={value}
          autoFocus
          data-inline-field-editing="true"
          {...(placeholder === undefined ? {} : { placeholder })}
          onFocus={(event) => event.target.select()}
          onBlur={(event) => {
            setEditing(false);
            onChange(event.target.value.trim());
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            // Escape discards without saving — leaves `onChange` uncalled,
            // same idiom Finance's `InlineEditText` uses.
            if (event.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <button
          type="button"
          id={id}
          onClick={() => setEditing(true)}
          title={value || undefined}
          className={cn(
            'hover:bg-muted/50 flex h-9 w-full items-center rounded-md border border-dashed px-3 text-left text-sm transition-colors',
            value ? '' : 'text-muted-foreground italic',
          )}
        >
          <span className="truncate">{value || placeholder || 'Not set'}</span>
        </button>
      )}
    </div>
  );
}
