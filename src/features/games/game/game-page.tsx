'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, useTransition } from 'react';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { Field, FieldSelect, InlineField } from '@/features/games/field-controls';
import { isRealPlayYearDraft, type PlayYearDraft, PlayYearsPanel } from '@/features/games/play-years-panel';
import type { Game } from '@/server/db/games/games';
import { fromHoursInput, hours, toHoursInput } from '@/server/games/hours';
import {
  GAME_OWNERSHIPS,
  GAME_STATUSES,
  PLATFORM_LABELS,
  PLATFORM_PICKER_OPTIONS,
  STATUS_LABELS,
} from '@/server/games/taxonomy';
import type { GameOwnership } from '@/server/games/taxonomy';
import type { GameSuggestion } from '@/server/games/metadata';
import { deleteGameAction, updateGameAction } from '../game-actions';
import { searchGameMetadataAction } from '../metadata-actions';
import { fetchGameTrophiesAction } from './trophy-actions';
import { GameSummaryPanel } from './game-summary-panel';
import { GameViewContent } from './game-view-content';
import { TrophiesSection, type TrophyFetchState } from './trophies-section';

const OWNERSHIP_UNSET = 'unset';
const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_MIN_LENGTH = 3;

type SearchStatus = 'idle' | 'loading' | 'results' | 'empty';
type Mode = 'view' | 'edit';

/**
 * The full per-game page — everything that used to live in `GameDialog`'s
 * edit path, moved here, plus a live-fetched Trophies section. `GameDialog`
 * (`library/game-dialog.tsx`) still exists, trimmed to create-only — this
 * component only ever receives a real, already-saved `Game`.
 *
 * Opens read-only (`mode: 'view'`): a two-column profile layout, cover art
 * and "at a glance" facts in a persistent left column
 * (`GameSummaryPanel`), plain formatted text on the right
 * (`GameViewContent`) — no inputs anywhere. "Edit" switches the right
 * column to the same field set as before, minus the old tabs (stacked
 * sections instead). "Cancel" calls `resetFromGame` (discards any
 * unsaved edits) and returns to view mode without touching the server; a
 * successful Save does the same, since local state already holds exactly
 * what was just persisted.
 *
 * Every field is controlled state now, including ones that used to be
 * `defaultValue`-only (rating, first-played year, achievement counts,
 * platinum, notes, price) — view mode needs a real, JS-readable value to
 * format as text, and the left column's summary card needs the same live
 * values regardless of which mode the right column is in.
 *
 * Metadata lookup is search-as-you-type: debounced 300ms after the last
 * keystroke, minimum 3 characters, with each new keystroke superseding
 * whatever request came before it. Picking a result fills cover art, genre,
 * developer and publisher.
 *
 * `genre`/`developer`/`publisher` fill only into a field that is still
 * EMPTY — a hand-typed value must never be silently replaced by IGDB's, so
 * once one holds a value a later pick leaves it alone. `coverUrl` is
 * deliberately NOT guarded that way: it has no input control anywhere in
 * this form, so a pick is the only way it can ever change, and guarding it
 * on "still empty" would make re-picking a cover on a game that already had
 * one a silent no-op. `metacritic`/`averagePlaytimeHours`/`esrbRating` have
 * no hand-editable control at all and always take the latest pick's value.
 */
export function GamePage({ game }: { readonly game: Game }): React.ReactElement {
  const router = useRouter();

  const [mode, setMode] = useState<Mode>('view');
  const [platform, setPlatform] = useState(game.platform);
  const [status, setStatus] = useState(game.status);
  // Explicit type argument — `game.ownership ?? ''` alone widens to plain
  // `string` (the fresh `''` literal absorbs the narrower union in the
  // inferred type), which only surfaces as an error once this state is
  // passed to a prop actually typed `GameOwnership | ''`, as `GameViewContent`'s is.
  const [ownership, setOwnership] = useState<GameOwnership | ''>(game.ownership ?? '');
  const [coverUrl, setCoverUrl] = useState(game.coverUrl ?? '');
  const [genre, setGenre] = useState(game.genre ?? '');
  const [developer, setDeveloper] = useState(game.developer ?? '');
  const [publisher, setPublisher] = useState(game.publisher ?? '');
  const [metacritic, setMetacritic] = useState<number | null>(game.metacritic ?? null);
  const [averagePlaytimeHours, setAveragePlaytimeHours] = useState<number | null>(
    game.averagePlaytimeHours ?? null,
  );
  const [esrbRating, setEsrbRating] = useState<string | null>(game.esrbRating ?? null);
  const [title, setTitle] = useState(game.title);
  const [hoursFieldValue, setHoursFieldValue] = useState(
    game.hoursTenths === null ? '' : toHoursInput(hours(game.hoursTenths)),
  );
  const [playYears, setPlayYears] = useState<readonly PlayYearDraft[]>(
    game.playYears.map((row) => ({ year: String(row.year), hours: toHoursInput(hours(row.hoursTenths)) })),
  );
  const [showSplit, setShowSplit] = useState(game.playYears.length > 0);
  const [rating, setRating] = useState(String(game.rating ?? ''));
  const [firstPlayedYear, setFirstPlayedYear] = useState(String(game.firstPlayedYear ?? ''));
  const [achievementsUnlocked, setAchievementsUnlocked] = useState(String(game.achievementsUnlocked ?? ''));
  const [achievementsTotal, setAchievementsTotal] = useState(String(game.achievementsTotal ?? ''));
  const [platinum, setPlatinum] = useState(game.platinum);
  const [notes, setNotes] = useState(game.notes ?? '');
  const [priceDollars, setPriceDollars] = useState(game.priceCents == null ? '' : (game.priceCents / 100).toFixed(2));
  // A linked game has its total hours and achievement counts written by
  // Steam sync (see `commitSyncRun` in src/server/db/games/sync.ts), so this
  // form must not let the owner type over them — the Hours/Achievements
  // `Field`s below render disabled + a "From Steam" note when this is true.
  // Disabling is a UI affordance only; `updateGameAction` independently
  // drops these fields from the write regardless of what the form submits.
  const steamOwned = game.steamAppid !== null;
  const [suggestions, setSuggestions] = useState<readonly GameSuggestion[]>([]);
  const [searchStatus, setSearchStatus] = useState<SearchStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [pending, startTransition] = useTransition();
  const [, startSearch] = useTransition();

  const suppressNextSearchRef = useRef(false);
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

  /** Re-derives every piece of controlled state from `game` — Cancel's undo. */
  function resetFromGame(): void {
    setPlatform(game.platform);
    setStatus(game.status);
    setOwnership(game.ownership ?? '');
    setCoverUrl(game.coverUrl ?? '');
    setGenre(game.genre ?? '');
    setDeveloper(game.developer ?? '');
    setPublisher(game.publisher ?? '');
    setMetacritic(game.metacritic ?? null);
    setAveragePlaytimeHours(game.averagePlaytimeHours ?? null);
    setEsrbRating(game.esrbRating ?? null);
    setTitle(game.title);
    setHoursFieldValue(game.hoursTenths === null ? '' : toHoursInput(hours(game.hoursTenths)));
    setPlayYears(game.playYears.map((row) => ({ year: String(row.year), hours: toHoursInput(hours(row.hoursTenths)) })));
    setShowSplit(game.playYears.length > 0);
    setRating(String(game.rating ?? ''));
    setFirstPlayedYear(String(game.firstPlayedYear ?? ''));
    setAchievementsUnlocked(String(game.achievementsUnlocked ?? ''));
    setAchievementsTotal(String(game.achievementsTotal ?? ''));
    setPlatinum(game.platinum);
    setNotes(game.notes ?? '');
    setPriceDollars(game.priceCents == null ? '' : (game.priceCents / 100).toFixed(2));
    setSuggestions([]);
    setSearchStatus('idle');
    setError(null);
  }

  function cancel(): void {
    resetFromGame();
    setMode('view');
  }

  function submit(formData: FormData): void {
    setError(null);
    formData.set('platform', platform);
    formData.set('status', status);
    formData.set('ownership', ownership);
    formData.set('coverUrl', coverUrl);
    formData.set('metacritic', metacritic === null ? '' : String(metacritic));
    formData.set('averagePlaytimeHours', averagePlaytimeHours === null ? '' : String(averagePlaytimeHours));
    formData.set('esrbRating', esrbRating ?? '');
    formData.set('playYears', JSON.stringify(playYears.filter(isRealPlayYearDraft)));
    // Radix's Checkbox only bubbles a native form value through a `name`
    // prop's hidden input, which this app has previously found subtler to
    // trust than every other control here (`FieldSelect`'s own comment,
    // above) — set explicitly rather than relying on it.
    formData.set('platinum', platinum ? 'true' : '');

    startTransition(async () => {
      const result = await updateGameAction(game.id, formData);
      if (result.ok) {
        toast.success('Game updated');
        setMode('view');
        return;
      }
      setError(result.error);
    });
  }

  function remove(): void {
    startTransition(async () => {
      const result = await deleteGameAction(game.id);
      if (result.ok) {
        toast.success(`${game.title} removed`);
        router.push('/games/library');
        return;
      }
      toast.error(result.error);
    });
  }

  const trophyFetchStartedRef = useRef(false);
  const [trophyState, setTrophyState] = useState<TrophyFetchState>({ status: 'idle' });
  const hasTrophies = game.psnNpCommunicationId !== null;
  // A separate transition from `pending` above — that one drives the
  // Save/Remove buttons' disabled state and "Saving…" label. Sharing one
  // transition between them meant the auto-fetch below (now eager, unlike
  // the old lazy-on-tab-click fetch) could still be in flight when the
  // owner clicked Edit → Save moments after opening the page, showing
  // "Saving…" on a button that was not, in fact, saving anything.
  const [, startTrophyTransition] = useTransition();

  // Fires once, automatically, as soon as the page mounts — there is no tab
  // to click anymore, and a PSN-linked game's trophies are meant to just be
  // part of the page (see this component's own doc comment).
  useEffect(() => {
    if (!hasTrophies || trophyFetchStartedRef.current) return;
    trophyFetchStartedRef.current = true;
    setTrophyState({ status: 'loading' });
    startTrophyTransition(async () => {
      const result = await fetchGameTrophiesAction(game.id);
      setTrophyState(
        result.ok ? { status: 'loaded', trophies: result.trophies } : { status: 'failed', reason: result.reason },
      );
    });
  }, [hasTrophies, game.id, startTrophyTransition]);

  const ratingNumber = rating.trim() === '' ? null : Number(rating);

  return (
    <>
      <PageHeader
        title={title}
        className="mt-2"
        actions={
          mode === 'view' ? (
            <>
              <Button type="button" variant="ghost" onClick={() => setConfirmingDelete(true)}>
                <Trash2 className="size-4" />
                Remove
              </Button>
              <Button
                type="button"
                onClick={() => {
                  // Deferred, not a direct `setMode('edit')` — this button
                  // and the edit-mode Save button (`type="submit" form=
                  // "game-form"`) render at the identical position in the
                  // header. Switching mode synchronously, inside this click
                  // handler, mounts Save at that exact spot WHILE the
                  // native click event is still finishing its dispatch —
                  // React 19 was found to treat that still-in-flight event
                  // as reaching the newly-mounted submit button too,
                  // auto-submitting the form the instant Edit is clicked
                  // (confirmed live: `submit()` fired with a full set of
                  // FormData entries before this handler had even
                  // returned). Deferring the state update to a fresh task
                  // lets the click event finish first, so the swap happens
                  // on a tick with nothing left to (mis)dispatch. The
                  // reverse (Cancel → a plain, non-submit Edit button) does
                  // not exhibit this and needs no such guard — verified
                  // live.
                  setTimeout(() => setMode('edit'), 0);
                }}
              >
                <Pencil className="size-4" />
                Edit
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={cancel} disabled={pending}>
                Cancel
              </Button>
              <Button type="submit" form="game-form" disabled={pending}>
                {pending ? 'Saving…' : 'Save'}
              </Button>
            </>
          )
        }
      />

      <div className="mx-auto mt-6 grid max-w-4xl gap-8 sm:grid-cols-[280px_1fr]">
        <GameSummaryPanel
          coverUrl={coverUrl === '' ? null : coverUrl}
          title={title}
          platform={platform}
          status={status}
          rating={Number.isFinite(ratingNumber) ? ratingNumber : null}
          hoursTenths={fromHoursInput(hoursFieldValue)}
          platinum={platinum}
        />

        {mode === 'view' ? (
          <GameViewContent
            ownership={ownership}
            priceDollars={priceDollars}
            genre={genre}
            developer={developer}
            publisher={publisher}
            firstPlayedYear={firstPlayedYear}
            achievementsUnlocked={achievementsUnlocked}
            achievementsTotal={achievementsTotal}
            playYears={playYears}
            notes={notes}
          />
        ) : (
          <form id="game-form" action={submit} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                name="title"
                value={title}
                onChange={(event) => {
                  titleEditedRef.current = true;
                  setTitle(event.target.value);
                }}
                required
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

            <section className="space-y-4 border-t pt-4">
              <h2 className="text-muted-foreground text-xs font-medium">Details</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <FieldSelect
                  id="platform"
                  label="Platform"
                  value={platform}
                  onChange={(value) => setPlatform(value as typeof platform)}
                  options={(platform === 'pc'
                    ? [...PLATFORM_PICKER_OPTIONS, 'pc' as const]
                    : PLATFORM_PICKER_OPTIONS
                  ).map((value) => ({ value, label: PLATFORM_LABELS[value] }))}
                />
                <FieldSelect
                  id="ownership"
                  label="Ownership"
                  value={ownership === '' ? OWNERSHIP_UNSET : ownership}
                  onChange={(value) => setOwnership(value === OWNERSHIP_UNSET ? '' : (value as typeof ownership))}
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
                  value={priceDollars}
                  onChange={setPriceDollars}
                  placeholder="59.99"
                />
                <InlineField id="genre" label="Genre" value={genre} onChange={setGenre} placeholder="Action RPG" />
                <InlineField id="developer" label="Developer" value={developer} onChange={setDeveloper} />
                <InlineField id="publisher" label="Publisher" value={publisher} onChange={setPublisher} />
              </div>
            </section>

            <section className="space-y-4 border-t pt-4">
              <h2 className="text-muted-foreground text-xs font-medium">Progress</h2>
              <div className="grid gap-4 sm:grid-cols-2">
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
                <Field id="rating" label="Rating (1-5)" value={rating} onChange={setRating} placeholder="4" />
                <Field
                  id="firstPlayedYear"
                  label="First played (year)"
                  value={firstPlayedYear}
                  onChange={setFirstPlayedYear}
                  placeholder="2026"
                />
                <Field
                  id="achievementsUnlocked"
                  label="Achievements earned"
                  value={achievementsUnlocked}
                  onChange={setAchievementsUnlocked}
                  placeholder="42"
                  disabled={steamOwned}
                  hint={steamOwned ? 'From Steam' : null}
                />
                <Field
                  id="achievementsTotal"
                  label="Achievements total"
                  value={achievementsTotal}
                  onChange={setAchievementsTotal}
                  placeholder="54"
                  disabled={steamOwned}
                  hint={steamOwned ? 'From Steam' : null}
                />
                <div className="flex items-center gap-2">
                  <Checkbox id="platinum" checked={platinum} onCheckedChange={(checked) => setPlatinum(checked === true)} />
                  <Label htmlFor="platinum" className="cursor-pointer font-normal">
                    Platinum trophy earned
                  </Label>
                </div>
              </div>
            </section>

            <section className="space-y-2 border-t pt-4">
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                name="notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="e.g. 6 hrs of that was the DLC in 2026"
                rows={6}
              />
            </section>
          </form>
        )}
      </div>

      {hasTrophies ? (
        <div className="mx-auto mt-8 max-w-4xl">
          <h2 className="text-muted-foreground mb-2 text-xs font-medium">Trophies</h2>
          <TrophiesSection state={trophyState} />
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={`Remove "${game.title}"?`}
        description="This deletes the entry and its history from your library. This can't be undone."
        confirmLabel="Remove"
        destructive
        onConfirm={remove}
      />
    </>
  );
}
