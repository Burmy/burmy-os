'use client';

import { useCallback } from 'react';

import type { Game } from '@/server/db/games/games';
import type { CollectionGroup } from '@/server/games/collections';
import { GameCard } from './game-card';
import { useGridDrag } from './grid-drag';

/**
 * ONE CARD PER TOP-LEVEL ROW. A collection's titles get no card of their own.
 *
 * That is the whole point of the collections work: the three games inside
 * "Uncharted: The Nathan Drake Collection" have no cover art of their own and
 * never will — IGDB has art for the collection, not for a remaster that only
 * ships inside it — so giving them cards would put three letter-tiles in a
 * wall of box art. The collection's own card carries a "3 games" marker and
 * opens the panel, which lists them ("Games in this collection").
 *
 * Reading the titles inside a collection is what TABLE view is for, which is
 * exactly the split `game-card.tsx` already makes for every other fact about
 * a game.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DRAG TO REORDER (2026-10-19). With `onReorder` the grid is sortable through
 * `useGridDrag` — a purpose-built pointer drag for a uniform grid that does no
 * React work while a card is in hand (see that file for why dnd-kit was
 * replaced here). A drop reports the two ids involved; the caller computes
 * and persists the new order (`library-view.tsx`, `moveTopLevel`). Without
 * `onReorder` the cards carry no drag props at all.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function GameGrid({
  groups,
  activeId,
  onOpen,
  onReorder,
}: {
  readonly groups: readonly CollectionGroup<Game>[];
  /** The game the side panel is showing, if any — its card gets a ring. */
  readonly activeId: string | null;
  readonly onOpen: (game: Game) => void;
  /** Present exactly when the gallery may be reordered — see `library-view.tsx` for when that is. */
  readonly onReorder?: (activeId: string, overId: string) => void;
}): React.ReactElement {
  const sortable = onReorder !== undefined;
  const onDrop = useCallback(
    (from: number, to: number) => {
      const a = groups[from]?.game.id;
      const b = groups[to]?.game.id;
      if (a !== undefined && b !== undefined && onReorder) onReorder(a, b);
    },
    [groups, onReorder],
  );
  const labelOf = useCallback((index: number) => groups[index]?.game.title ?? '', [groups]);
  const { setItem, itemProps, announcement, instructionsId } = useGridDrag({
    count: sortable ? groups.length : 0,
    layoutKey: groups,
    onDrop,
    labelOf,
  });

  return (
    <>
      {/* Caps at 5 columns, down from 7, and holds at 4 until `2xl` (1536px).
          Real usage found the denser grid "too compact" — cover art too small
          to recognize a game without reading its title, which defeats the point
          of a cover-first card (see `game-card.tsx`). The 5th column only
          appears once there's genuinely room for it; on a typical ~1400px
          window that means 4 noticeably larger covers rather than 5 cramped
          ones. `gap-6` matches the app's shared 24px spacing step. */}
      <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
        {groups.map((group, index) => (
          // The wrapper is what the drag moves: its transform is written
          // directly, with the transition below for the cards stepping aside
          // (the card in hand gets `transition: none` inline while held).
          <div
            key={group.game.id}
            ref={sortable ? (el) => setItem(index, el) : undefined}
            className="rounded-md transition-transform duration-220 ease-[cubic-bezier(0.2,0,0,1)]"
          >
            <GameCard
              game={group.game}
              memberCount={group.members.length}
              selected={group.game.id === activeId}
              onOpen={onOpen}
              {...(sortable && itemProps[index] ? { drag: itemProps[index] } : {})}
            />
          </div>
        ))}
      </div>
      {sortable ? (
        <>
          <p id={instructionsId} className="sr-only">
            Press Space to pick the game up, use the arrow keys to move it, and press Space again to
            drop it. Press Escape to cancel.
          </p>
          <div aria-live="assertive" aria-atomic="true" className="sr-only">
            {announcement}
          </div>
        </>
      ) : null}
    </>
  );
}
