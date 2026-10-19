'use client';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMemo } from 'react';

import { cn } from '@/lib/utils';
import type { Game } from '@/server/db/games/games';
import { GameCard } from './game-card';

/**
 * A gallery card that can be dragged into a new position.
 *
 * The wrapper `div` is what dnd-kit measures and moves (`transform`/
 * `transition` as inline styles — allowed by the app's `style-src-attr`
 * exception; dnd-kit injects no stylesheet). The CARD's own button is the
 * activator: the drag listeners and the sortable ARIA attributes go on it,
 * so a plain click still opens the panel, a 6px mouse move (or a 250ms press
 * on touch — see `game-grid.tsx`'s sensors) starts a drag, and the keyboard
 * can pick the card up with Space. The card dims while its overlay copy
 * follows the pointer.
 *
 * `drag` is memoised on dnd-kit's own memoised `attributes`/`listeners`, so
 * the memoised `GameCard` under it skips every re-render a pointer move
 * causes — only the dragged card's attributes (`aria-pressed`) change.
 */
export function SortableCard({
  game,
  memberCount,
  selected,
  onOpen,
}: {
  readonly game: Game;
  readonly memberCount: number;
  readonly selected: boolean;
  readonly onOpen: (game: Game) => void;
}): React.ReactElement {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: game.id });

  const drag = useMemo(
    () => ({
      setActivator: setActivatorNodeRef,
      props: { ...attributes, ...listeners } as React.ButtonHTMLAttributes<HTMLButtonElement>,
    }),
    [attributes, listeners, setActivatorNodeRef],
  );

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && 'opacity-40')}
    >
      <GameCard
        game={game}
        memberCount={memberCount}
        selected={selected}
        onOpen={onOpen}
        drag={drag}
      />
    </div>
  );
}
