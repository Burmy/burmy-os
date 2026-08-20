'use client';

import Image from 'next/image';
import { Search, Trash2 } from 'lucide-react';
import { useState, useTransition } from 'react';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import type { Game } from '@/server/db/games/games';
import { hours, toHoursInput } from '@/server/games/hours';
import {
  GAME_OWNERSHIPS,
  GAME_PLATFORMS,
  GAME_STATUSES,
  PLATFORM_LABELS,
  STATUS_LABELS,
} from '@/server/games/taxonomy';
import type { GameSuggestion } from '@/server/games/metadata';
import { createGameAction, deleteGameAction, updateGameAction } from '../game-actions';
import { searchGameMetadataAction } from '../metadata-actions';

/**
 * Radix `Select` treats an item `value=""` as "no selection" — `<SelectValue />`
 * then renders blank instead of the item's label, so an unset-ownership game
 * looked like a broken empty box. This sentinel stands in for "not set" only
 * inside the `<Select>`'s own `value`/`onChange`; the ownership `FieldSelect`
 * below translates it back to `''` before it ever reaches `ownership` state or
 * `FormData`, so it is never submitted as a literal value.
 */
const OWNERSHIP_UNSET = 'unset';

/**
 * Add or edit one game.
 *
 * Metadata lookup is opt-in per game via the Search button rather than firing
 * on every keystroke: it is a third-party network call, the owner often knows
 * the exact title already, and an unprompted autocomplete that silently
 * overwrites a hand-typed developer field is worse than a button.
 */
export function GameDialog({
  game,
  open,
  onOpenChange,
}: {
  readonly game: Game | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const [platform, setPlatform] = useState(game?.platform ?? 'ps5');
  const [status, setStatus] = useState(game?.status ?? 'backlog');
  const [ownership, setOwnership] = useState(game?.ownership ?? '');
  const [coverUrl, setCoverUrl] = useState(game?.coverUrl ?? '');
  const [genre, setGenre] = useState(game?.genre ?? '');
  const [developer, setDeveloper] = useState(game?.developer ?? '');
  const [publisher, setPublisher] = useState(game?.publisher ?? '');
  const [title, setTitle] = useState(game?.title ?? '');
  const [suggestions, setSuggestions] = useState<readonly GameSuggestion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [pending, startTransition] = useTransition();
  const [searching, startSearch] = useTransition();

  function lookUp(): void {
    startSearch(async () => {
      const results = await searchGameMetadataAction(title);
      setSuggestions(results);
      if (results.length === 0) toast.error('No matches found — fill the details in by hand.');
    });
  }

  function applySuggestion(suggestion: GameSuggestion): void {
    setTitle(suggestion.title);
    if (suggestion.coverUrl !== null) setCoverUrl(suggestion.coverUrl);
    if (suggestion.genre !== null) setGenre(suggestion.genre);
    if (suggestion.developer !== null) setDeveloper(suggestion.developer);
    if (suggestion.publisher !== null) setPublisher(suggestion.publisher);
    setSuggestions([]);
  }

  function submit(formData: FormData): void {
    // Cleared here, not just on success, so a second submit never shows the
    // PREVIOUS attempt's error while the new one is still pending.
    setError(null);
    formData.set('platform', platform);
    formData.set('status', status);
    formData.set('ownership', ownership);
    formData.set('coverUrl', coverUrl);

    startTransition(async () => {
      const result = game === null
        ? await createGameAction(formData)
        : await updateGameAction(game.id, formData);

      if (result.ok) {
        toast.success(game === null ? 'Game added' : 'Game updated');
        onOpenChange(false);
        return;
      }
      setError(result.error);
    });
  }

  function remove(): void {
    if (game === null) return;
    startTransition(async () => {
      const result = await deleteGameAction(game.id);
      if (result.ok) {
        toast.success(`${game.title} removed`);
        onOpenChange(false);
        return;
      }
      toast.error(result.error);
    });
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        {/* `sm:max-w-2xl`, not the unprefixed form: DialogContent's own base class
            is `sm:max-w-lg`, and Tailwind emits responsive variants AFTER their
            unprefixed counterparts regardless of className order, so an
            unprefixed override silently loses at any viewport >=640px. */}
        <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{game === null ? 'Add game' : game.title}</DialogTitle>
          </DialogHeader>

          <form action={submit} className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <div className="flex gap-2">
                <Input
                  id="title"
                  name="title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  required
                  autoFocus
                />
                <Button type="button" variant="outline" onClick={lookUp} disabled={searching || title.trim().length < 2}>
                  <Search className="size-4" />
                  {searching ? 'Searching…' : 'Find art'}
                </Button>
              </div>
              {error === null ? null : (
                <p role="alert" className="text-destructive text-sm">
                  {error}
                </p>
              )}
            </div>

            {suggestions.length === 0 ? null : (
              <ul className="grid grid-cols-3 gap-2 rounded-md border p-2 sm:grid-cols-6">
                {suggestions.map((suggestion) => (
                  <li key={suggestion.externalId}>
                    <button
                      type="button"
                      onClick={() => applySuggestion(suggestion)}
                      className="hover:ring-ring block w-full overflow-hidden rounded text-left hover:ring-2"
                    >
                      <span className="bg-muted relative block aspect-[3/4] w-full">
                        {suggestion.coverUrl === null ? null : (
                          <Image src={suggestion.coverUrl} alt="" fill sizes="120px" className="object-cover" />
                        )}
                      </span>
                      <span className="line-clamp-2 p-1 text-xs">{suggestion.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <FieldSelect
                id="platform"
                label="Platform"
                value={platform}
                onChange={(value) => setPlatform(value as typeof platform)}
                options={GAME_PLATFORMS.map((value) => ({ value, label: PLATFORM_LABELS[value] }))}
              />
              <FieldSelect
                id="status"
                label="Status"
                value={status}
                onChange={(value) => setStatus(value as typeof status)}
                options={GAME_STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] }))}
              />
              <Field
                id="hours"
                label="Hours played"
                defaultValue={game === null || game.hoursTenths === null ? '' : toHoursInput(hours(game.hoursTenths))}
                placeholder="23.5"
              />
              <Field id="firstPlayedYear" label="First played (year)" defaultValue={game?.firstPlayedYear ?? ''} placeholder="2026" />
              <Field id="rating" label="Rating (1-5)" defaultValue={game?.rating ?? ''} placeholder="4" />
              <FieldSelect
                id="ownership"
                label="Ownership"
                value={ownership === '' ? OWNERSHIP_UNSET : ownership}
                onChange={(value) => setOwnership(value === OWNERSHIP_UNSET ? '' : (value as typeof ownership))}
                options={[
                  { value: OWNERSHIP_UNSET, label: 'Not set' },
                  ...GAME_OWNERSHIPS.map((value) => ({ value, label: value === 'physical' ? 'Physical' : 'Digital' })),
                ]}
              />
              <Field id="achievementsUnlocked" label="Achievements earned" defaultValue={game?.achievementsUnlocked ?? ''} placeholder="42" />
              <Field id="achievementsTotal" label="Achievements total" defaultValue={game?.achievementsTotal ?? ''} placeholder="54" />
              <Field id="priceDollars" label="Price paid" defaultValue={game?.priceCents == null ? '' : (game.priceCents / 100).toFixed(2)} placeholder="59.99" />
              <Field id="genre" label="Genre" value={genre} onChange={setGenre} placeholder="Action RPG" />
              <Field id="developer" label="Developer" value={developer} onChange={setDeveloper} />
              <Field id="publisher" label="Publisher" value={publisher} onChange={setPublisher} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                name="notes"
                defaultValue={game?.notes ?? ''}
                placeholder="e.g. 6 hrs of that was the DLC in 2026"
                rows={3}
              />
            </div>

            <DialogFooter className="justify-between sm:justify-between">
              {game === null ? (
                <span />
              ) : (
                <Button type="button" variant="ghost" onClick={() => setConfirmingDelete(true)} disabled={pending}>
                  <Trash2 className="size-4" />
                  Remove
                </Button>
              )}
              <Button type="submit" disabled={pending}>
                {pending ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={`Remove "${game?.title}"?`}
        description="This deletes the entry and its history from your library. This can't be undone."
        confirmLabel="Remove"
        destructive
        onConfirm={remove}
      />
    </>
  );
}

function Field({
  id,
  label,
  defaultValue,
  value,
  onChange,
  placeholder,
}: {
  readonly id: string;
  readonly label: string;
  readonly defaultValue?: string | number;
  readonly value?: string;
  readonly onChange?: (value: string) => void;
  readonly placeholder?: string;
}): React.ReactElement {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={id}
        {...(value === undefined ? { defaultValue } : { value, onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange?.(e.target.value) })}
        {...(placeholder === undefined ? {} : { placeholder })}
      />
    </div>
  );
}

function FieldSelect({
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
