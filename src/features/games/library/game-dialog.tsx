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
import {
  isRealPlayYearDraft,
  type PlayYearDraft,
  PlayYearsPanel,
} from '@/features/games/play-years-panel';
import { fromHoursInput, hours, toHoursInput } from '@/server/games/hours';
import { GAME_OWNERSHIPS, PLATFORM_LABELS, PLATFORM_PICKER_OPTIONS } from '@/server/games/taxonomy';
import type { GameSuggestion } from '@/server/games/metadata';
import type { Game } from '@/server/db/games/games';
import { completeWishlistGameAction, createGameAction } from '../game-actions';
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
 * Add a game to the library. Two ways in, one form:
 *
 *   - `mode: 'create'` (the default) — "Add game" from the Library. A brand-new
 *     row with no id yet; the owner usually fills only a handful of fields.
 *   - `mode: 'complete'` — "Mark as played" on a wishlist card. The row
 *     already exists as `wanted`, so title, platform, cover and the IGDB
 *     metadata are pre-filled from it — and so is EVERY figure the row already
 *     carries (a pre-order price, a note, hours logged before it was marked), all
 *     still editable, because the action parses in `'update'` mode where an
 *     absent field means "cleared". The status control is hidden (it is
 *     `played`, that is the whole point), and submit goes to
 *     `completeWishlistGameAction` so the SAME row moves into the library —
 *     never a duplicate. The dialog is keyed on the game by its caller, so
 *     every `useState` initialiser below reads the row once, on mount.
 *
 * Editing an EXISTING library game lives in the side panel
 * (`src/features/games/panel/game-panel.tsx`) — per-field, no modal. This
 * dialog is for the moment a game ENTERS the library, where a handful of
 * fields entered together is the better shape.
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
type PickerPlatform = (typeof PLATFORM_PICKER_OPTIONS)[number];

/** `pc` is stored but no longer offered in the picker — see `PLATFORM_PICKER_OPTIONS`. */
function pickerPlatform(platform: Game['platform']): PickerPlatform {
  return (PLATFORM_PICKER_OPTIONS as readonly string[]).includes(platform)
    ? (platform as PickerPlatform)
    : 'ps5';
}

export function GameDialog({
  open,
  onOpenChange,
  mode = 'create',
  game,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly mode?: 'create' | 'complete';
  /** The wishlist row being completed. Required when `mode` is `'complete'`; ignored otherwise. */
  readonly game?: Game;
}): React.ReactElement {
  const completing = mode === 'complete' ? (game ?? null) : null;
  const [platform, setPlatform] = useState<PickerPlatform>(
    completing === null ? 'ps5' : pickerPlatform(completing.platform),
  );
  const [ownership, setOwnership] = useState(completing?.ownership ?? '');
  const [coverUrl, setCoverUrl] = useState(completing?.coverUrl ?? '');
  const [genre, setGenre] = useState(completing?.genre ?? '');
  const [developer, setDeveloper] = useState(completing?.developer ?? '');
  const [publisher, setPublisher] = useState(completing?.publisher ?? '');
  const [metacritic, setMetacritic] = useState<number | null>(completing?.metacritic ?? null);
  const [averagePlaytimeHours, setAveragePlaytimeHours] = useState<number | null>(
    completing?.averagePlaytimeHours ?? null,
  );
  const [esrbRating, setEsrbRating] = useState<string | null>(completing?.esrbRating ?? null);
  const [title, setTitle] = useState(completing?.title ?? '');
  const [hoursFieldValue, setHoursFieldValue] = useState(
    completing?.hoursTenths == null ? '' : toHoursInput(hours(completing.hoursTenths)),
  );
  const [playYears, setPlayYears] = useState<readonly PlayYearDraft[]>(() =>
    (completing?.playYears ?? []).map((row) => ({
      year: String(row.year),
      hours: toHoursInput(hours(row.hoursTenths)),
    })),
  );
  const [showSplit, setShowSplit] = useState((completing?.playYears.length ?? 0) > 0);
  // Uncontrolled fields take the row's figure as their initial value in
  // complete mode; `defaultValue` is spread in conditionally so an absent
  // figure stays an absent prop (`exactOptionalPropertyTypes`).
  const initial = (value: string | number | null | undefined) =>
    value == null ? {} : { defaultValue: value };
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
    // `played` is the invisible default and the word never appears in the
    // UI: the only status choice a NEW game offers is one checkbox, "Add to
    // wishlist instead". Completing a wishlist entry IS marking it played —
    // nothing the form carried can say otherwise.
    formData.set(
      'status',
      completing === null && formData.get('wishlist') === 'true' ? 'wanted' : 'played',
    );
    formData.delete('wishlist');
    formData.set('ownership', ownership);
    formData.set('coverUrl', coverUrl);
    formData.set('metacritic', metacritic === null ? '' : String(metacritic));
    formData.set(
      'averagePlaytimeHours',
      averagePlaytimeHours === null ? '' : String(averagePlaytimeHours),
    );
    formData.set('esrbRating', esrbRating ?? '');
    formData.set('playYears', JSON.stringify(playYears.filter(isRealPlayYearDraft)));

    startTransition(async () => {
      const result =
        completing === null
          ? await createGameAction(formData)
          : await completeWishlistGameAction(completing.id, formData);
      if (result.ok) {
        toast.success(completing === null ? 'Game added' : `${title} added to your library`);
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
          <DialogTitle>{completing === null ? 'Add game' : 'Add to library'}</DialogTitle>
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
                <p className="text-muted-foreground text-xs">
                  No matches found — fill the details in by hand.
                </p>
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
                          <Image
                            src={suggestion.coverUrl}
                            alt=""
                            fill
                            sizes="120px"
                            className="object-cover"
                          />
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
                {averagePlaytimeHours === null ? null : (
                  <span>~{averagePlaytimeHours}h to beat</span>
                )}
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
             * cleared" — and complete mode submits in exactly that mode, so
             * `forceMount` is what keeps a pre-filled figure on an inactive
             * tab from being blanked on submit. It also means unmounting
             * would lose whatever the owner typed into a tab they've since
             * switched away from.
             */}
            <Tabs defaultValue="details">
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
                    options={PLATFORM_PICKER_OPTIONS.map((value) => ({
                      value,
                      label: PLATFORM_LABELS[value],
                    }))}
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
                  <Field
                    id="priceDollars"
                    label="Price paid"
                    placeholder="59.99"
                    {...initial(
                      completing?.priceCents == null
                        ? undefined
                        : (completing.priceCents / 100).toFixed(2),
                    )}
                  />
                  {/* Genre/Developer/Publisher are almost always IGDB-filled and
                      rarely hand-edited — a compact click-to-edit control instead
                      of three permanently-open input boxes, matching the density
                      of the read-only Metacritic/beat-time/ESRB strip above. */}
                  <InlineField
                    id="genre"
                    label="Genre"
                    value={genre}
                    onChange={setGenre}
                    placeholder="Action RPG"
                  />
                  <InlineField
                    id="developer"
                    label="Developer"
                    value={developer}
                    onChange={setDeveloper}
                  />
                  <InlineField
                    id="publisher"
                    label="Publisher"
                    value={publisher}
                    onChange={setPublisher}
                  />
                </div>
              </TabsContent>

              <TabsContent
                value="progress"
                forceMount
                className="pt-4 data-[state=inactive]:hidden"
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  {/* The one status decision a new game has. Same Radix
                      Checkbox-posts-a-hidden-input mechanics as the platinum
                      box below; absent when completing a wishlist entry. */}
                  {completing === null ? (
                    <div className="flex items-center gap-2 sm:col-span-2">
                      <Checkbox id="wishlist" name="wishlist" value="true" />
                      <Label htmlFor="wishlist" className="cursor-pointer font-normal">
                        Add to wishlist instead
                      </Label>
                    </div>
                  ) : null}
                  <Field
                    id="hours"
                    label="Hours played"
                    value={hoursFieldValue}
                    onChange={setHoursFieldValue}
                    placeholder="23.5"
                  />
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
                  <Field
                    id="rating"
                    label="Rating (1-5)"
                    placeholder="4"
                    {...initial(completing?.rating)}
                  />
                  <Field
                    id="firstPlayedYear"
                    label="First played (year)"
                    placeholder="2026"
                    {...initial(completing?.firstPlayedYear)}
                  />
                  <Field
                    id="achievementsUnlocked"
                    label="Achievements earned"
                    placeholder="42"
                    {...initial(completing?.achievementsUnlocked)}
                  />
                  <Field
                    id="achievementsTotal"
                    label="Achievements total"
                    placeholder="54"
                    {...initial(completing?.achievementsTotal)}
                  />
                  {/*
                   * Radix's Checkbox renders a hidden native input mirroring its
                   * state (`name`/`value` bubble through to real FormData), so an
                   * UNCHECKED box omits the "platinum" key entirely — same as a
                   * plain HTML checkbox. `parse()` in game-actions.ts relies on
                   * exactly that to tell "not earned" apart from "not touched."
                   */}
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="platinum"
                      name="platinum"
                      value="true"
                      defaultChecked={completing?.platinum ?? false}
                    />
                    <Label htmlFor="platinum" className="cursor-pointer font-normal">
                      Platinum trophy earned
                    </Label>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="notes" forceMount className="pt-4 data-[state=inactive]:hidden">
                <div className="space-y-2">
                  <Label htmlFor="notes">Notes</Label>
                  <Textarea
                    id="notes"
                    name="notes"
                    placeholder="e.g. 6 hrs of that was the DLC in 2026"
                    rows={6}
                    {...initial(completing?.notes)}
                  />
                </div>
              </TabsContent>
            </Tabs>
          </div>

          <DialogFooter className="mt-4 justify-end border-t pt-4">
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : completing === null ? 'Add game' : 'Add to library'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
