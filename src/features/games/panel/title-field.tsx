'use client';

import Image from 'next/image';
import { Loader2 } from 'lucide-react';
import { useEffect, useState, useTransition } from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';
import type { ActionResult } from '@/features/games/action-result';
import { applyMetadataSuggestionAction, type GameFieldKey } from '@/features/games/game-actions';
import { searchGameMetadataAction } from '@/features/games/metadata-actions';
import type { Game } from '@/server/db/games/games';
import type { GameSuggestion } from '@/server/games/metadata';

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_MIN_LENGTH = 3;

/**
 * The panel's heading, and the one field that can trigger a richer,
 * multi-field update: editing it debounce-searches IGDB, and picking a
 * suggestion applies title + cover art + (only-if-currently-empty)
 * genre/developer/publisher + metacritic/average-playtime/ESRB together,
 * via `applyMetadataSuggestionAction` — a real batch, unlike every other
 * field in the panel. Typing a title and just blurring away (no pick) saves
 * only the title, through the same single-field action every other row uses.
 *
 * `onChanged` fires after a successful suggestion pick so the panel can
 * re-fetch — the pick writes several columns at once and the panel's copy of
 * the game is otherwise stale until it does.
 */
export function TitleField({
  game,
  onSaveField,
  onChanged,
}: {
  readonly game: Game;
  readonly onSaveField: (field: GameFieldKey, value: string) => Promise<ActionResult>;
  readonly onChanged: () => void;
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
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    onChanged();
  }

  if (!editing) {
    return (
      <button
        type="button"
        // The visible text is the title alone; the label names the field for
        // assistive tech, the way every other row's button does.
        aria-label={`Title: ${game.title}`}
        onClick={() => {
          setDraft(game.title);
          setEditing(true);
        }}
        className="hover:text-muted-foreground -mx-1 -my-0.5 block max-w-full rounded-md px-1 py-0.5 text-center text-lg leading-tight font-semibold transition-colors"
      >
        <span className="line-clamp-2">{game.title}</span>
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
        <ul className="bg-card grid grid-cols-3 gap-2 rounded-md p-2">
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
                      sizes="160px"
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
