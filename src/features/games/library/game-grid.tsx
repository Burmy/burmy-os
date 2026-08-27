'use client';

import type { Game } from '@/server/db/games/games';
import { GameCard } from './game-card';

export function GameGrid({
  games,
  onOpen,
}: {
  readonly games: readonly Game[];
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
      {games.map((game) => (
        <GameCard key={game.id} game={game} onOpen={onOpen} />
      ))}
    </div>
  );
}
