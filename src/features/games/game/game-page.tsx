'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { ExternalLink, Loader2, Trash2 } from 'lucide-react';
import { useEffect, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { toast } from '@/components/ui/toast';
import type { ActionResult } from '@/features/games/action-result';
import type { PlayYearDraft } from '@/features/games/play-years-panel';
import type { Game } from '@/server/db/games/games';
import type { Trophy } from '@/server/games/trophies';
import type { GameSuggestion } from '@/server/games/metadata';
import {
  applyMetadataSuggestionAction,
  deleteGameAction,
  type GameFieldKey,
  updateGameFieldAction,
  updateGamePlayYearsAction,
} from '../game-actions';
import { searchGameMetadataAction } from '../metadata-actions';
import { GameDetailsContent } from './game-view-content';
import { GameSummaryPanel } from './game-summary-panel';
import { TrophiesSection } from './trophies-section';

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_MIN_LENGTH = 3;

/**
 * The full per-game page. Every field saves itself independently the
 * instant it's committed — click a value, it becomes a real control, blur/
 * change saves it via `updateGameFieldAction` (one generic Server Action,
 * validated per-field — see that action's own doc comment), and the page
 * simply re-renders with the fresh `game` prop Next hands it after
 * `revalidatePath` — no local mirroring of "the current value of every
 * field," no page-wide Edit/Save/Cancel toggle. Real usage of the
 * previous round's whole-page toggle found it was the wrong model: click
 * one field (say, Ownership), you should only be editing that field.
 *
 * `game` is read straight through to every child as the single source of
 * truth for "what's the current value" — there is deliberately no
 * `useState(game.field)` anywhere in this file for a value a save action
 * can change; only pure UI state (is this field mid-edit, is a delete
 * confirmation open) lives here.
 */
export function GamePage({
  game,
  trophies,
}: {
  readonly game: Game;
  /**
   * Read from `game_trophies` by the page's Server Component and handed down
   * whole. This used to be fetched from PSN in a mount effect here, costing
   * ~1.5s on every visit — see `trophies-section.tsx` for why that is gone.
   */
  readonly trophies: readonly Trophy[];
}): React.ReactElement {
  const router = useRouter();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deletePending, startDeleteTransition] = useTransition();

  const steamOwned = game.steamAppid !== null;

  async function saveField(field: GameFieldKey, value: string): Promise<ActionResult> {
    return updateGameFieldAction(game.id, field, value);
  }

  async function savePlayYears(drafts: readonly PlayYearDraft[]): Promise<ActionResult> {
    return updateGamePlayYearsAction(game.id, drafts);
  }

  function remove(): void {
    startDeleteTransition(async () => {
      const result = await deleteGameAction(game.id);
      if (result.ok) {
        toast.success(`${game.title} removed`);
        router.push('/games/library');
        return;
      }
      toast.error(result.error);
    });
  }


  return (
    <>
      <PageHeader
        title={game.title}
        className="mt-2"
        actions={
          <Button
            type="button"
            variant="ghost"
            onClick={() => setConfirmingDelete(true)}
            disabled={deletePending}
          >
            <Trash2 className="size-4" />
            Remove
          </Button>
        }
      />

      <div className="mt-6 grid gap-8 sm:grid-cols-[280px_1fr]">
        <GameSummaryPanel
          coverUrl={game.coverUrl}
          title={game.title}
          platform={game.platform}
          status={game.status}
          rating={game.rating}
          hoursTenths={game.hoursTenths}
          platinum={game.platinum}
          steamOwned={steamOwned}
          onSaveField={saveField}
        />

        {/* No width cap any more. It was here to stop a label and its value
            drifting to opposite ends of a wide row, but `GameDetailsContent`
            now splits the fields into two ~490px columns, which keeps them
            adjacent by construction — and the cap had become the reason a
            quarter of the page sat empty. */}
        <div className="space-y-4">
          <TitleField game={game} onSaveField={saveField} />

          <GameDetailsContent
            ownership={game.ownership}
            priceCents={game.priceCents}
            genre={game.genre}
            developer={game.developer}
            publisher={game.publisher}
            firstPlayedYear={game.firstPlayedYear}
            achievementsUnlocked={game.achievementsUnlocked}
            achievementsTotal={game.achievementsTotal}
            steamOwned={steamOwned}
            notes={game.notes}
            hoursTenths={game.hoursTenths}
            playYears={game.playYears}
            onSaveField={saveField}
            onSavePlayYears={savePlayYears}
          />
        </div>
      </div>

      {/* Shown whenever the game is PSN/Steam-linked, even with zero stored
          rows — `TrophiesSection`'s empty state is what tells the owner to run
          a sync, and hiding the section entirely would leave nothing to say
          that from. */}
      {trophies.length > 0 || game.psnNpCommunicationId !== null || game.steamAppid !== null ? (
        <div className="mt-8">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-muted-foreground text-xs font-medium">Trophies</h2>
            {/* A real button, not the 12px grey link this used to be. Looking
                up a trophy guide is the one thing you actually DO from this
                section, so it gets the same solid treatment as Add game and
                Export rather than hiding at the weight of a caption. */}
            <Button asChild size="sm">
              <a
                href={`https://www.powerpyx.com/?s=${encodeURIComponent(game.title)}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Find on PowerPyx
                <ExternalLink className="size-3.5" aria-hidden />
              </a>
            </Button>
          </div>
          <TrophiesSection trophies={trophies} />
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

/**
 * The title is the one field that can trigger a richer, multi-field
 * update: editing it debounce-searches IGDB, and picking a suggestion
 * applies title + cover art + (only-if-currently-empty) genre/developer/
 * publisher + metacritic/average-playtime/ESRB together, via
 * `applyMetadataSuggestionAction` — a real batch, unlike every other field
 * on this page. Typing a title and just blurring away (no pick) saves only
 * the title, through the same single-field action every other row uses.
 */
function TitleField({
  game,
  onSaveField,
}: {
  readonly game: Game;
  readonly onSaveField: (field: GameFieldKey, value: string) => Promise<ActionResult>;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(game.title);
  const [suggestions, setSuggestions] = useState<readonly GameSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [, startSearch] = useTransition();
  const [applying, setApplying] = useState(false);

  // Below-threshold input is handled by deriving `visibleSuggestions` at
  // render time (below), not by clearing `suggestions` here — setting
  // state synchronously inside an effect body triggers a second render for
  // no reason a plain derived value doesn't already cover.
  const belowSearchThreshold =
    draft.trim() === game.title.trim() || draft.trim().length < SEARCH_MIN_LENGTH;
  const visibleSuggestions = belowSearchThreshold ? [] : suggestions;

  useEffect(() => {
    if (!editing || belowSearchThreshold) return;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      startSearch(async () => {
        const results = await searchGameMetadataAction(draft);
        if (controller.signal.aborted) return;
        setSuggestions(results);
        setSearching(false);
      });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [editing, belowSearchThreshold, draft]);

  async function commitTitle(): Promise<void> {
    setEditing(false);
    setSuggestions([]);
    const trimmed = draft.trim();
    if (trimmed === game.title || trimmed === '') {
      setDraft(game.title);
      return;
    }
    const result = await onSaveField('title', trimmed);
    if (!result.ok) {
      toast.error(result.error);
      setDraft(game.title);
    }
  }

  async function applySuggestion(suggestion: GameSuggestion): Promise<void> {
    setApplying(true);
    const result = await applyMetadataSuggestionAction(game.id, {
      title: suggestion.title,
      coverUrl: suggestion.coverUrl,
      ...(game.genre === null && suggestion.genre !== null ? { genre: suggestion.genre } : {}),
      ...(game.developer === null && suggestion.developer !== null
        ? { developer: suggestion.developer }
        : {}),
      ...(game.publisher === null && suggestion.publisher !== null
        ? { publisher: suggestion.publisher }
        : {}),
      metacritic: suggestion.metacritic,
      averagePlaytimeHours: suggestion.averagePlaytimeHours,
      esrbRating: suggestion.esrbRating,
    });
    setApplying(false);
    setEditing(false);
    setSuggestions([]);
    if (!result.ok) toast.error(result.error);
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(game.title);
          setEditing(true);
        }}
        className="hover:text-foreground -mx-1 -my-1 grid w-full grid-cols-[9rem_1fr] items-start gap-3 rounded-md px-1 py-1 text-left text-sm transition-colors"
      >
        <span className="text-muted-foreground">Title</span>
        <span className="truncate">{game.title}</span>
      </button>
    );
  }

  return (
    <div className="space-y-2">
      <Label htmlFor="title-edit">Title</Label>
      <Input
        id="title-edit"
        value={draft}
        autoFocus
        onFocus={(event) => event.target.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commitTitle()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            setDraft(game.title);
            setEditing(false);
            setSuggestions([]);
          }
        }}
      />
      {searching ? (
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <Loader2 className="size-3 animate-spin" aria-hidden />
          Searching…
        </p>
      ) : null}
      {visibleSuggestions.length === 0 ? null : (
        <ul className="bg-card grid grid-cols-3 gap-2 rounded-md p-2 sm:grid-cols-6">
          {visibleSuggestions.map((suggestion) => (
            <li key={suggestion.externalId}>
              <button
                type="button"
                disabled={applying}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void applySuggestion(suggestion)}
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
    </div>
  );
}
