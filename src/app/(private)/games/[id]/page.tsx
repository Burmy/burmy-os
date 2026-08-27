import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { GamePage } from '@/features/games/game/game-page';
import { requireOwner } from '@/server/auth/owner';
import { GameNotFoundError } from '@/server/db/games/errors';
import { getGame } from '@/server/db/games/games';
import { listGameTrophies } from '@/server/db/games/trophies';

export const metadata: Metadata = { title: 'Game — Burmy' };

/**
 * The per-game edit page — everything that used to live in `GameDialog`'s
 * edit path plus a Trophies section read from `game_trophies`,
 * all in one place. A sibling of `(tabs)/` and `sync/[runId]/`, not nested
 * inside the tabs route group: the Library/Upcoming/Stats sub-nav belongs
 * to the three list-shaped screens, not a single-entity detail page — this
 * mirrors `sync/[runId]/page.tsx`'s own "own top-level dynamic segment,
 * `← Games`-style back-link" shape exactly.
 *
 * `getGame` throws `GameNotFoundError` for a missing OR not-owned row (one
 * error for both, so a crafted id can't be used to probe another owner's
 * data — see that error's own doc comment) rather than returning `null`.
 * `notFound()` on catch is the same shape `finance/import/[importId]/page.tsx`
 * already uses for the identical "owner-scoped single entity, page-level
 * 404" problem — reused here rather than adding a second,
 * `null`-returning DAL function.
 */
export default async function GameDetailPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  const owner = await requireOwner();

  let game;
  try {
    game = await getGame(owner.userId, id);
  } catch (error) {
    if (error instanceof GameNotFoundError) notFound();
    throw error;
  }

  // Read here rather than fetched by the client: trophies are persisted by
  // the syncs now, so they come down with the page instead of costing a ~1.5s
  // PSN round trip after it has already rendered.
  const trophies = await listGameTrophies(owner.userId, game.id);

  return (
    <div>
      <Link href="/games/library" className="text-muted-foreground hover:text-foreground text-sm">
        ← Library
      </Link>
      <GamePage game={game} trophies={trophies} />
    </div>
  );
}
