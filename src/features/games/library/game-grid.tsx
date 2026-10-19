'use client';

import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { useState } from 'react';

import type { Game } from '@/server/db/games/games';
import type { CollectionGroup } from '@/server/games/collections';
import { GameCard } from './game-card';
import { SortableCard } from './sortable-card';

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
 * DRAG TO REORDER (2026-10-19). With `onReorder` the grid is sortable: cards
 * shift smoothly into the gap as one is dragged (`rectSortingStrategy`), the
 * lifted card follows the pointer as an overlay copy, and a drop reports the
 * two ids involved — the caller computes and persists the new order
 * (`library-view.tsx`, `moveTopLevel`). Without `onReorder` the DOM is exactly
 * what it was before: plain cards, no context, nothing to measure.
 *
 * Three sensors, on purpose. A mouse starts a drag after 6px of movement, so
 * a click still opens the panel; a touch starts one after a 250ms press (with
 * 8px of tolerance), so a scroll still scrolls and a tap still opens; the
 * keyboard picks a card up with Space and moves it with the arrows. One
 * `PointerSensor` cannot give mouse and touch different constraints, which
 * is why it is Mouse + Touch here.
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
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const sortable = onReorder !== undefined;

  const grid = (
    // Caps at 5 columns, down from 7, and holds at 4 until `2xl` (1536px).
    // Real usage found the denser grid "too compact" — cover art too small
    // to recognize a game without reading its title, which defeats the point
    // of a cover-first card (see `game-card.tsx`). The 5th column only
    // appears once there's genuinely room for it; on a typical ~1400px
    // window that means 4 noticeably larger covers rather than 5 cramped
    // ones. `gap-6` matches the app's shared 24px spacing step.
    <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
      {groups.map((group) =>
        sortable ? (
          <SortableCard
            key={group.game.id}
            game={group.game}
            memberCount={group.members.length}
            selected={group.game.id === activeId}
            onOpen={onOpen}
          />
        ) : (
          <GameCard
            key={group.game.id}
            game={group.game}
            memberCount={group.members.length}
            selected={group.game.id === activeId}
            onOpen={onOpen}
          />
        ),
      )}
    </div>
  );

  if (!sortable) return grid;

  const dragging =
    draggingId === null ? null : groups.find((group) => group.game.id === draggingId);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={(event: DragStartEvent) => setDraggingId(String(event.active.id))}
      onDragCancel={() => setDraggingId(null)}
      onDragEnd={(event: DragEndEvent) => {
        setDraggingId(null);
        if (event.over !== null && event.over.id !== event.active.id) {
          onReorder(String(event.active.id), String(event.over.id));
        }
      }}
    >
      <SortableContext items={groups.map((group) => group.game.id)} strategy={rectSortingStrategy}>
        {grid}
      </SortableContext>
      {/* The lifted card. A copy, so the real one can dim in place and the
          grid can animate around the gap while this follows the pointer. */}
      <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' }}>
        {dragging === null || dragging === undefined ? null : (
          <div className="scale-[1.03] rounded-md shadow-2xl">
            <GameCard
              game={dragging.game}
              memberCount={dragging.members.length}
              selected={dragging.game.id === activeId}
              onOpen={() => undefined}
            />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
