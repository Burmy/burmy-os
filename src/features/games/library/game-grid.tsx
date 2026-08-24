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
    // One extra step at `md` (was a straight 3->5 jump) and a cap at `2xl` —
    // without it, cards on an ultra-wide monitor just keep getting wider
    // past 6 columns' worth of space instead of adding a 7th column.
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
      {games.map((game) => (
        <GameCard key={game.id} game={game} onOpen={onOpen} />
      ))}
    </div>
  );
}
