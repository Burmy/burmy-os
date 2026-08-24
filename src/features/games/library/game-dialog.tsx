'use client';

import Image from 'next/image';
import { Loader2, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, useTransition } from 'react';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { fromHoursInput, hours, toHoursInput } from '@/server/games/hours';
import {
  GAME_OWNERSHIPS,
  GAME_STATUSES,
  PLATFORM_LABELS,
  PLATFORM_PICKER_OPTIONS,
  STATUS_LABELS,
} from '@/server/games/taxonomy';
import type { GameSuggestion } from '@/server/games/metadata';
import { createGameAction, deleteGameAction, updateGameAction } from '../game-actions';
import { searchGameMetadataAction } from '../metadata-actions';
import { isRealPlayYearDraft, type PlayYearDraft, PlayYearsPanel } from './play-years-panel';

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
 * developer and publisher.
 *
 * `genre`/`developer`/`publisher` fill only into a field that is still EMPTY:
 * they are the owner's own editable fields (a hand-typed genre must never be
 * silently replaced by IGDB's), so once one holds a value — hand-typed, loaded
 * from an existing game, or filled by an earlier pick — a later pick leaves it
 * alone.
 *
 * `coverUrl` is deliberately NOT guarded that way, unlike the three above it
 * once was grouped with. It has no input control anywhere in this form, so a
 * pick is the ONLY way it can ever change and there is no hand-typed value to
 * protect. Guarding it on `=== ''` meant re-picking a wrong cover on a game
 * that already had one silently did nothing — and still reported "Game
 * updated," because the submit genuinely succeeded, just with the unchanged
 * URL. A `null` cover on the incoming pick is still skipped, so choosing an
 * entry IGDB has no art for never blanks art that already works. `metacritic`,
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
  // Seeded exactly as the Hours `Field`'s own `defaultValue` was before this
  // field became controlled — see the comment below the JSX for why it has to
  // be controlled at all.
  const [hoursFieldValue, setHoursFieldValue] = useState(
    game === null || game.hoursTenths === null ? '' : toHoursInput(hours(game.hoursTenths)),
  );
  const [playYears, setPlayYears] = useState<readonly PlayYearDraft[]>(
    (game?.playYears ?? []).map((row) => ({ year: String(row.year), hours: toHoursInput(hours(row.hoursTenths)) })),
  );
  const [showSplit, setShowSplit] = useState((game?.playYears ?? []).length > 0);
  // A linked game has its total hours and achievement counts written by
  // Steam sync (see `commitSyncRun` in src/server/db/games/sync.ts), so this
  // form must not let the owner type over them — the Hours/Achievements
  // `Field`s below render disabled + a "From Steam" note when this is true.
  // Disabling is a UI affordance only; `updateGameAction` independently
  // drops these fields from the write regardless of what the form submits.
  // The play-year split stays fully editable either way — Steam knows the
  // total, only the owner knows which year it happened in.
  const steamOwned = game?.steamAppid !== null && game?.steamAppid !== undefined;
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

  // True only once the owner has actually typed into the title field — set
  // in the Input's own onChange handler below, nowhere else.
  //
  // Opening an EXISTING game seeds `title` from `game.title`, which is
  // almost always >= SEARCH_MIN_LENGTH, so the debounce effect fired on
  // mount and hit IGDB immediately for a game that already has all its
  // metadata — wasted quota on every single card open. The effect cannot
  // simply key on `title` alone (or on `title.length >= SEARCH_MIN_LENGTH`)
  // because that can't distinguish "just opened, never touched" from "owner
  // typed a 3+ character title" — both look identical to the effect once
  // `title` itself is the only signal. It also cannot compare against the
  // dialog's INITIAL title (e.g. `title !== game?.title`): that silently
  // re-enables the exact same bug the moment the owner types a correction
  // and then types it back to the original text — a real edit that should
  // still search, but "changed vs. initial" would read it as unchanged. A
  // dedicated ref set only by the field's own change handler is the only
  // signal that means "the owner is genuinely editing this field."
  const titleEditedRef = useRef(false);

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

    // Nothing to search until the owner has actually edited the field —
    // see `titleEditedRef`'s own comment above for why this can't be
    // inferred from `title` itself.
    if (!titleEditedRef.current) return;

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
    // No `coverUrl === ''` guard — see the note on this component. Cover art
    // has no input control, so an explicit pick is the only way to change it.
    if (suggestion.coverUrl !== null) setCoverUrl(suggestion.coverUrl);
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
    // `isRealPlayYearDraft` is shared with the panel's own live validation —
    // dropping a row here that the panel still counted would silently submit
    // a split the screen never actually showed (see its doc comment). Only a
    // row that is COMPLETELY empty is safe to drop; a row with just a year or
    // just hours still needs to reach the server so it can be rejected there.
    formData.set('playYears', JSON.stringify(playYears.filter(isRealPlayYearDraft)));

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
                onChange={(event) => {
                  // The one and only place this ref is set — see its
                  // declaration above for why.
                  titleEditedRef.current = true;
                  setTitle(event.target.value);
                }}
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
                // `pc` is excluded going forward (see PLATFORM_PICKER_OPTIONS),
                // but a hypothetical EXISTING `pc` game must still show its real
                // platform when edited rather than a blank Select whose current
                // value matches no item in the list.
                options={(platform === 'pc' ? [...PLATFORM_PICKER_OPTIONS, 'pc' as const] : PLATFORM_PICKER_OPTIONS).map(
                  (value) => ({ value, label: PLATFORM_LABELS[value] }),
                )}
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
                value={hoursFieldValue}
                onChange={setHoursFieldValue}
                placeholder="23.5"
                disabled={steamOwned}
                hint={steamOwned ? 'From Steam' : null}
              />
              <div className="sm:col-span-2">
                {showSplit ? (
                  <PlayYearsPanel
                    value={playYears}
                    onChange={setPlayYears}
                    totalTenths={fromHoursInput(hoursFieldValue) ?? 0}
                  />
                ) : (
                  <Button type="button" variant="link" size="sm" className="px-0" onClick={() => setShowSplit(true)}>
                    Split across years
                  </Button>
                )}
              </div>
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
              <Field
                id="achievementsUnlocked"
                label="Achievements earned"
                defaultValue={game?.achievementsUnlocked ?? ''}
                placeholder="42"
                disabled={steamOwned}
                hint={steamOwned ? 'From Steam' : null}
              />
              <Field
                id="achievementsTotal"
                label="Achievements total"
                defaultValue={game?.achievementsTotal ?? ''}
                placeholder="54"
                disabled={steamOwned}
                hint={steamOwned ? 'From Steam' : null}
              />
              {/*
               * Radix's Checkbox renders a hidden native input mirroring its
               * state (`name`/`value` bubble through to real FormData), so an
               * UNCHECKED box omits the "platinum" key entirely — same as a
               * plain HTML checkbox. `parse()` in game-actions.ts relies on
               * exactly that to tell "not earned" apart from "not touched."
               * Uncontrolled (`defaultChecked`, not `checked`/`onCheckedChange`)
               * like the other plain `Field`s above, unlike platform/status
               * (which need controlled state only because Radix's Select does
               * not post a native form value at all).
               */}
              <div className="flex items-center gap-2">
                <Checkbox id="platinum" name="platinum" value="true" defaultChecked={game?.platinum ?? false} />
                <Label htmlFor="platinum" className="cursor-pointer font-normal">
                  Platinum trophy earned
                </Label>
              </div>
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
