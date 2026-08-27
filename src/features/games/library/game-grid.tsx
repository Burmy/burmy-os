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
    // Caps at 5 columns, down from 7. Real usage found the denser grid
    // "too compact" — at 7-up the cover art was too small to recognize a
    // game without reading its title, which defeats the point of a
    // cover-first card (see `game-card.tsx`). `gap-6` matches the app's
    // shared 24px spacing step.
    <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {games.map((game) => (
        <GameCard key={game.id} game={game} onOpen={onOpen} />
      ))}
    </div>
  );
}
