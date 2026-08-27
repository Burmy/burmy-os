'use client';

import Image from 'next/image';
import { Loader2, Plus } from 'lucide-react';
import { useEffect, useRef, useState, useTransition } from 'react';

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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { Field, FieldSelect, InlineField } from '@/features/games/field-controls';
import { isRealPlayYearDraft, type PlayYearDraft, PlayYearsPanel } from '@/features/games/play-years-panel';
import { fromHoursInput } from '@/server/games/hours';
import {
  GAME_OWNERSHIPS,
  GAME_STATUSES,
  PLATFORM_LABELS,
  PLATFORM_PICKER_OPTIONS,
  STATUS_LABELS,
} from '@/server/games/taxonomy';
import type { GameSuggestion } from '@/server/games/metadata';
import { createGameAction } from '../game-actions';
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
 * Add a new game — create-only. Editing an EXISTING game now lives on its
 * own page (`src/features/games/game/game-page.tsx`, reached from a
 * Library card/row click) with a Trophies section alongside the same
 * Details/Progress/Notes content this dialog still uses for the initial
 * add — this dialog stays a lightweight modal specifically because a
 * brand-new game has no id to route to yet, no trophies, and usually only
 * needs a handful of fields to start.
 *
 * Metadata lookup is search-as-you-type: debounced 300ms after the last
 * keystroke, minimum 3 characters, with each new keystroke superseding
 * whatever request came before it. Picking a result fills cover art, genre,
 * developer and publisher.
 *
 * `genre`/`developer`/`publisher` fill only into a field that is still EMPTY:
 * they are the owner's own editable fields (a hand-typed genre must never be
 * silently replaced by IGDB's), so once one holds a value — hand-typed or
 * filled by an earlier pick — a later pick leaves it alone.
 *
 * `coverUrl` is deliberately NOT guarded that way, unlike the three above it
 * once was grouped with. It has no input control anywhere in this form, so a
 * pick is the ONLY way it can ever change and there is no hand-typed value to
 * protect. `metacritic`, `averagePlaytimeHours` and `esrbRating` have no
 * hand-editable control at all (read-only third-party facts) and always take
 * the latest pick's value.
 */
export function GameDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const [platform, setPlatform] = useState<(typeof PLATFORM_PICKER_OPTIONS)[number]>('ps5');
  const [status, setStatus] = useState<(typeof GAME_STATUSES)[number]>('backlog');
  const [ownership, setOwnership] = useState('');
  const [coverUrl, setCoverUrl] = useState('');
  const [genre, setGenre] = useState('');
  const [developer, setDeveloper] = useState('');
  const [publisher, setPublisher] = useState('');
  const [metacritic, setMetacritic] = useState<number | null>(null);
  const [averagePlaytimeHours, setAveragePlaytimeHours] = useState<number | null>(null);
  const [esrbRating, setEsrbRating] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [hoursFieldValue, setHoursFieldValue] = useState('');
  const [playYears, setPlayYears] = useState<readonly PlayYearDraft[]>([]);
  const [showSplit, setShowSplit] = useState(false);
  const [suggestions, setSuggestions] = useState<readonly GameSuggestion[]>([]);
  const [searchStatus, setSearchStatus] = useState<SearchStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [, startSearch] = useTransition();

  // Set right before `setTitle` inside `applySuggestion`, so the debounce
  // effect below can tell "the title changed because a pick just normalized
  // it" apart from "the owner typed another character" and skip firing a
  // redundant search for the former.
  const suppressNextSearchRef = useRef(false);

  // True only once the owner has actually typed into the title field — set
  // in the Input's own onChange handler below, nowhere else. Without this,
  // the debounce effect would have nothing to distinguish "just opened" from
  // "owner typed a 3+ character title" once title itself is the only signal.
  const titleEditedRef = useRef(false);

  const belowMinLength = title.trim().length < SEARCH_MIN_LENGTH;
  const visibleSuggestions = belowMinLength ? [] : suggestions;
  const visibleSearchStatus: SearchStatus = belowMinLength ? 'idle' : searchStatus;

  useEffect(() => {
    if (suppressNextSearchRef.current) {
      suppressNextSearchRef.current = false;
      return;
    }
    if (!titleEditedRef.current) return;
    if (title.trim().length < SEARCH_MIN_LENGTH) return;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearchStatus('loading');
      startSearch(async () => {
        const results = await searchGameMetadataAction(title);
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
    if (suggestion.coverUrl !== null) setCoverUrl(suggestion.coverUrl);
    if (genre === '' && suggestion.genre !== null) setGenre(suggestion.genre);
    if (developer === '' && suggestion.developer !== null) setDeveloper(suggestion.developer);
    if (publisher === '' && suggestion.publisher !== null) setPublisher(suggestion.publisher);
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
    formData.set('playYears', JSON.stringify(playYears.filter(isRealPlayYearDraft)));

    startTransition(async () => {
      const result = await createGameAction(formData);
      if (result.ok) {
        toast.success('Game added');
        onOpenChange(false);
        return;
      }
      setError(result.error);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* `sm:max-w-2xl`, not the unprefixed form: DialogContent's own base class
          is `sm:max-w-lg`, and Tailwind emits responsive variants AFTER their
          unprefixed counterparts regardless of className order, so an
          unprefixed override silently loses at any viewport >=640px. */}
      <DialogContent
        className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl"
        // Radix's Dialog dismisses on Escape via a document-level CAPTURE
        // listener — it fires before an `InlineField`'s own `onKeyDown` (a
        // bubble-phase React handler) ever runs, so that handler's own
        // `stopPropagation()` cannot prevent it (verified: it did not).
        // `onEscapeKeyDown` is Radix's own documented hook for exactly this
        // — `event.target` is still the focused inline-edit input at the
        // moment Escape fires, so checking its marker attribute here and
        // calling `preventDefault()` stops the WHOLE DIALOG from closing,
        // letting the input's own handler cancel just that one field
        // instead. See `field-controls.tsx`'s `InlineField` for the other
        // half of this.
        onEscapeKeyDown={(event) => {
          if ((event.target as HTMLElement | null)?.dataset.inlineFieldEditing === 'true') {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Add game</DialogTitle>
        </DialogHeader>

        <form action={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-1">
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
              <ul className="bg-card grid grid-cols-3 gap-2 rounded-md p-2 sm:grid-cols-6">
                {visibleSuggestions.map((suggestion) => (
                  <li key={suggestion.externalId}>
                    <button
                      type="button"
                      onClick={() => applySuggestion(suggestion)}
                      className="hover:ring-ring block w-full overflow-hidden rounded-md text-left hover:ring-2"
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

            {/*
             * Three tabs instead of one long scrolling grid — the field
             * count didn't drop (progressive disclosure already tried that
             * and real usage still found it too dense/scrolly), but no
             * single view now shows more than ~8 fields at once.
             *
             * `forceMount` + CSS-hide on the inactive state, never Radix's
             * default (unmount the inactive panel). Every field below is a
             * native named input/hidden-input that reaches the server ONLY
             * because it is present in the DOM at submit time (see this
             * file's own doc comment on `submit()` — only a handful of
             * fields go through an explicit `formData.set(...)`, everything
             * else relies on native form collection). `game-actions.ts`'s
             * `parse()` treats an ABSENT key on update as "explicitly
             * cleared" — this dialog only ever creates, so that specific
             * risk doesn't apply here the way it does on the edit page, but
             * `forceMount` stays for consistency and because unmounting
             * would also lose whatever the owner already typed into a tab
             * they've since switched away from.
             */}
            <Tabs defaultValue="progress">
              <TabsList>
                <TabsTrigger value="details">Details</TabsTrigger>
                <TabsTrigger value="progress">Progress</TabsTrigger>
                <TabsTrigger value="notes">Notes</TabsTrigger>
              </TabsList>

              <TabsContent value="details" forceMount className="pt-4 data-[state=inactive]:hidden">
                <div className="grid gap-4 sm:grid-cols-2">
                  <FieldSelect
                    id="platform"
                    label="Platform"
                    value={platform}
                    onChange={(value) => setPlatform(value as typeof platform)}
                    options={PLATFORM_PICKER_OPTIONS.map((value) => ({ value, label: PLATFORM_LABELS[value] }))}
                  />
                  <FieldSelect
                    id="ownership"
                    label="Ownership"
                    value={ownership === '' ? OWNERSHIP_UNSET : ownership}
                    onChange={(value) => setOwnership(value === OWNERSHIP_UNSET ? '' : value)}
                    options={[
                      { value: OWNERSHIP_UNSET, label: 'Not set' },
                      ...GAME_OWNERSHIPS.map((value) => ({
                        value,
                        label: value === 'physical' ? 'Physical' : 'Digital',
                      })),
                    ]}
                  />
                  <Field id="priceDollars" label="Price paid" placeholder="59.99" />
                  {/* Genre/Developer/Publisher are almost always IGDB-filled and
                      rarely hand-edited — a compact click-to-edit control instead
                      of three permanently-open input boxes, matching the density
                      of the read-only Metacritic/beat-time/ESRB strip above. */}
                  <InlineField id="genre" label="Genre" value={genre} onChange={setGenre} placeholder="Action RPG" />
                  <InlineField id="developer" label="Developer" value={developer} onChange={setDeveloper} />
                  <InlineField id="publisher" label="Publisher" value={publisher} onChange={setPublisher} />
                </div>
              </TabsContent>

              <TabsContent value="progress" forceMount className="pt-4 data-[state=inactive]:hidden">
                <div className="grid gap-4 sm:grid-cols-2">
                  <FieldSelect
                    id="status"
                    label="Status"
                    value={status}
                    onChange={(value) => setStatus(value as typeof status)}
                    options={GAME_STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] }))}
                  />
                  <Field id="hours" label="Hours played" value={hoursFieldValue} onChange={setHoursFieldValue} placeholder="23.5" />
                  <div className="sm:col-span-2">
                    {showSplit ? (
                      <PlayYearsPanel
                        value={playYears}
                        onChange={setPlayYears}
                        totalTenths={fromHoursInput(hoursFieldValue) ?? 0}
                      />
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground -ml-2 gap-1.5 px-2"
                        onClick={() => setShowSplit(true)}
                      >
                        <Plus className="size-4" aria-hidden />
                        Split across years
                      </Button>
                    )}
                  </div>
                  <Field id="rating" label="Rating (1-5)" placeholder="4" />
                  <Field id="firstPlayedYear" label="First played (year)" placeholder="2026" />
                  <Field id="achievementsUnlocked" label="Achievements earned" placeholder="42" />
                  <Field id="achievementsTotal" label="Achievements total" placeholder="54" />
                  {/*
                   * Radix's Checkbox renders a hidden native input mirroring its
                   * state (`name`/`value` bubble through to real FormData), so an
                   * UNCHECKED box omits the "platinum" key entirely — same as a
                   * plain HTML checkbox. `parse()` in game-actions.ts relies on
                   * exactly that to tell "not earned" apart from "not touched."
                   */}
                  <div className="flex items-center gap-2">
                    <Checkbox id="platinum" name="platinum" value="true" />
                    <Label htmlFor="platinum" className="cursor-pointer font-normal">
                      Platinum trophy earned
                    </Label>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="notes" forceMount className="pt-4 data-[state=inactive]:hidden">
                <div className="space-y-2">
                  <Label htmlFor="notes">Notes</Label>
                  <Textarea id="notes" name="notes" placeholder="e.g. 6 hrs of that was the DLC in 2026" rows={6} />
                </div>
              </TabsContent>
            </Tabs>
          </div>

          <DialogFooter className="mt-4 justify-end border-t pt-4">
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Add game'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
