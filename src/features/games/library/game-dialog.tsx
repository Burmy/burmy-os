'use client';

import Image from 'next/image';
import { Loader2, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, useTransition } from 'react';

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

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_MIN_LENGTH = 3;

type SearchStatus = 'idle' | 'loading' | 'results' | 'empty';

/**
 * Add or edit one game.
 *
 * Metadata lookup is search-as-you-type: debounced 300ms after the last
 * keystroke, minimum 3 characters, with each new keystroke superseding
 * whatever request came before it. Picking a result fills cover art, genre,
 * developer and publisher — but only into a field that is still EMPTY.
 * `coverUrl`/`genre`/`developer`/`publisher` are the owner's own editable
 * fields (a hand-typed genre must never be silently replaced by IGDB's), so
 * once one holds a value — hand-typed, loaded from an existing game, or
 * filled by an earlier pick — a later pick leaves it alone. `metacritic`,
 * `averagePlaytimeHours` and `esrbRating` have no hand-editable control at
 * all (read-only third-party facts), so there is nothing of the owner's to
 * protect there and they always take the latest pick's value.
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
  const [metacritic, setMetacritic] = useState<number | null>(game?.metacritic ?? null);
  const [averagePlaytimeHours, setAveragePlaytimeHours] = useState<number | null>(
    game?.averagePlaytimeHours ?? null,
  );
  const [esrbRating, setEsrbRating] = useState<string | null>(game?.esrbRating ?? null);
  const [title, setTitle] = useState(game?.title ?? '');
  const [suggestions, setSuggestions] = useState<readonly GameSuggestion[]>([]);
  const [searchStatus, setSearchStatus] = useState<SearchStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [pending, startTransition] = useTransition();
  const [, startSearch] = useTransition();

  // Set right before `setTitle` inside `applySuggestion`, so the debounce
  // effect below can tell "the title changed because a pick just normalized
  // it" apart from "the owner typed another character" and skip firing a
  // redundant search for the former.
  const suppressNextSearchRef = useRef(false);

  const belowMinLength = title.trim().length < SEARCH_MIN_LENGTH;
  // Derived at render time rather than cleared with a synchronous setState
  // at the top of the effect below (that pattern trips
  // `react-hooks/set-state-in-effect`'s cascading-render check) — a
  // too-short title has nothing to schedule, so there is no effect-shaped
  // work here at all, only a display rule.
  const visibleSuggestions = belowMinLength ? [] : suggestions;
  const visibleSearchStatus: SearchStatus = belowMinLength ? 'idle' : searchStatus;

  useEffect(() => {
    if (suppressNextSearchRef.current) {
      suppressNextSearchRef.current = false;
      return;
    }

    if (title.trim().length < SEARCH_MIN_LENGTH) return;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearchStatus('loading');
      startSearch(async () => {
        const results = await searchGameMetadataAction(title);
        // Server Actions don't expose their own transport for a real
        // network-level abort, so this guard — not the AbortController
        // itself — is what actually stops a stale response (from a request
        // a newer keystroke already superseded) from overwriting fresher
        // results. The controller still exists so cancellation has one
        // mechanism (`controller.abort()`, in the cleanup below), the same
        // shape it would take against a plain fetch.
        if (controller.signal.aborted) return;
        setSuggestions(results);
        setSearchStatus(results.length === 0 ? 'empty' : 'results');
      });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [title, startSearch]);

  function applySuggestion(suggestion: GameSuggestion): void {
    suppressNextSearchRef.current = true;
    setTitle(suggestion.title);
    if (coverUrl === '' && suggestion.coverUrl !== null) setCoverUrl(suggestion.coverUrl);
    if (genre === '' && suggestion.genre !== null) setGenre(suggestion.genre);
    if (developer === '' && suggestion.developer !== null) setDeveloper(suggestion.developer);
    if (publisher === '' && suggestion.publisher !== null) setPublisher(suggestion.publisher);
    // Read-only, never hand-typed — always reflect the latest pick.
    setMetacritic(suggestion.metacritic);
    setAveragePlaytimeHours(suggestion.averagePlaytimeHours);
    setEsrbRating(suggestion.esrbRating);
    setSuggestions([]);
    setSearchStatus('idle');
  }

  function submit(formData: FormData): void {
    // Cleared here, not just on success, so a second submit never shows the
    // PREVIOUS attempt's error while the new one is still pending.
    setError(null);
    formData.set('platform', platform);
    formData.set('status', status);
    formData.set('ownership', ownership);
    formData.set('coverUrl', coverUrl);
    formData.set('metacritic', metacritic === null ? '' : String(metacritic));
    formData.set('averagePlaytimeHours', averagePlaytimeHours === null ? '' : String(averagePlaytimeHours));
    formData.set('esrbRating', esrbRating ?? '');

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
              <Input
                id="title"
                name="title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
                autoFocus
              />
              {visibleSearchStatus === 'loading' ? (
                <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                  Searching…
                </p>
              ) : visibleSearchStatus === 'empty' ? (
                <p className="text-muted-foreground text-xs">No matches found — fill the details in by hand.</p>
              ) : null}
              {error === null ? null : (
                <p role="alert" className="text-destructive text-sm">
                  {error}
                </p>
              )}
            </div>

            {visibleSuggestions.length === 0 ? null : (
              <ul className="grid grid-cols-3 gap-2 rounded-md border p-2 sm:grid-cols-6">
                {visibleSuggestions.map((suggestion) => (
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
                      <span className="line-clamp-2 p-1 text-xs">
                        {suggestion.title}
                        {suggestion.releaseYear === null ? '' : ` (${suggestion.releaseYear})`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {metacritic === null && averagePlaytimeHours === null && esrbRating === null ? null : (
              <p className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs">
                {metacritic === null ? null : <span>Metacritic {metacritic}</span>}
                {averagePlaytimeHours === null ? null : <span>~{averagePlaytimeHours}h to beat</span>}
                {esrbRating === null ? null : <span>ESRB {esrbRating}</span>}
              </p>
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
