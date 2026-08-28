'use client';

import type { Game } from '@/server/db/games/games';
import type { CollectionGroup } from '@/server/games/collections';
import { GameCard } from './game-card';

/**
 * ONE CARD PER TOP-LEVEL ROW. A collection's titles get no card of their own.
 *
 * That is the whole point of the collections work: the three games inside
 * "Uncharted: The Nathan Drake Collection" have no cover art of their own and
 * never will — IGDB has art for the collection, not for a remaster that only
 * ships inside it — so giving them cards would put three letter-tiles in a
 * wall of box art. The collection's own card carries a "3 games" marker and
 * opens a page that lists them (`GamePage`'s "Games in this collection").
 *
 * Reading the titles inside a collection is what TABLE view is for, which is
 * exactly the split `game-card.tsx` already makes for every other fact about
 * a game.
 */
export function GameGrid({
  groups,
  onOpen,
}: {
  readonly groups: readonly CollectionGroup<Game>[];
  readonly onOpen: (game: Game) => void;
}): React.ReactElement {
  return (
    // Caps at 5 columns, down from 7, and holds at 4 until `2xl` (1536px).
    // Real usage found the denser grid "too compact" — cover art too small
    // to recognize a game without reading its title, which defeats the point
    // of a cover-first card (see `game-card.tsx`). The 5th column only
    // appears once there's genuinely room for it; on a typical ~1400px
    // window that means 4 noticeably larger covers rather than 5 cramped
    // ones. `gap-6` matches the app's shared 24px spacing step.
    <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
      {groups.map((group) => (
        <GameCard
          key={group.game.id}
          game={group.game}
          memberCount={group.members.length}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}
