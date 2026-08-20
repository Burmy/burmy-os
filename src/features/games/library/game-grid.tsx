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
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
      {games.map((game) => (
        <GameCard key={game.id} game={game} onOpen={onOpen} />
      ))}
    </div>
  );
}
