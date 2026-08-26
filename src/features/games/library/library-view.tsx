'use client';

import { LayoutGrid, Plus, Rows3 } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { FilterChip } from '@/components/ui/filter-chip';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import type { Game } from '@/server/db/games/games';
import { GAME_PLATFORMS, GAME_STATUSES, PLATFORM_LABELS, STATUS_LABELS } from '@/server/games/taxonomy';
import type { GamePlatform, GameStatus } from '@/server/games/taxonomy';
import { PsnSyncButton } from '../sync/psn-sync-button';
import { SyncButton } from '../sync/sync-button';
import { GameDialog } from './game-dialog';
import { GameGrid } from './game-grid';
import { GameTable } from './game-table';

type ViewMode = 'gallery' | 'table';
type StatusFilter = GameStatus | 'all';
type PlatformFilter = GamePlatform | 'all';
// Provenance, not platform — `game.steamAppid !== null` is the same signal
// game-dialog.tsx uses to render Hours/Achievements read-only, independent
// of the `platform` field (a `steam` platform game can still be unlinked).

/**
 * The library screen. Owns view mode, status filter, platform filter, and
 * search — all client state, because every one of them is a pure re-render of
 * data already loaded, and round-tripping to the server to hide a card would
 * be latency for nothing.
 */
export function LibraryView({
  games,
  steamConfigured = false,
  psnConfigured = false,
}: {
  readonly games: readonly Game[];
  /**
   * Whether `STEAM_API_KEY`/`STEAM_ID` are set, computed server-side by the
   * Library page (`isSteamConfiguredAction`) — a Client Component cannot
   * read those env vars itself. Defaults to `false` (the safe, disabled-
   * with-explanation state) so existing callers and tests that don't pass it
   * keep working unchanged.
   */
  readonly steamConfigured?: boolean;
  /**
   * Whether `PSN_NPSSO` is set, computed server-side by the Library page
   * (`isPsnConfiguredAction`) — same reasoning as `steamConfigured` above,
   * and the same safe `false` default. Kept as its OWN prop rather than
   * folded into `steamConfigured`: the two Sync buttons are deliberately
   * independent (see `PsnSyncButton`'s own doc comment), so their configured
   * states must be independent too.
   */
  readonly psnConfigured?: boolean;
  // Last-synced times and PSN token age used to be threaded all the way
  // down to `SyncButton`/`PsnSyncButton` for their under-button captions.
  // That status now lives in Settings → Games → Sync
  // (`games-sync-section.tsx`), so the Library page no longer needs to fetch
  // or pass it here at all — see those two buttons' own doc comments.
}): React.ReactElement {
  const [view, setView] = useState<ViewMode>('gallery');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [platform, setPlatform] = useState<PlatformFilter>('all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Game | null>(null);
  const [creating, setCreating] = useState(false);

  // `wanted` (wishlist) games are hidden unless their own status chip is
  // active — see the plan's "Library hides it by default." Every OTHER
  // chip's count (status, platform) is computed over THIS set rather than
  // `games` directly, so none of them jump as the wishlist grows: a
  // wishlisted PS5 game shouldn't
  // inflate the "PS5" platform chip while it's still invisible in the
  // default view. `counts` (the per-status map) below is the one exception
  // that stays keyed off `games` — it has to be, since `wanted`'s own chip
  // needs a real count, and doing so changes nothing for the other statuses
  // (a `wanted` row is never counted under any OTHER status key either way).
  const filtered = status !== 'all' || platform !== 'all' || search.trim() !== '';

  const nonWantedGames = useMemo(() => games.filter((game) => game.status !== 'wanted'), [games]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return games.filter((game) => {
      if (status === 'all') {
        if (game.status === 'wanted') return false;
      } else if (game.status !== status) {
        return false;
      }
      if (platform !== 'all' && game.platform !== platform) return false;
      if (needle === '') return true;
      return (
        game.title.toLowerCase().includes(needle) ||
        (game.developer ?? '').toLowerCase().includes(needle) ||
        (game.publisher ?? '').toLowerCase().includes(needle)
      );
    });
  }, [games, status, platform, search]);

  // `playing` pinned first, within the existing order otherwise — a stable
  // sort (guaranteed by the spec since ES2019) that only ever compares "is
  // this the one game currently in progress," so every other status keeps
  // whatever relative order `visible` already had. The gallery additionally
  // renders a `playing` card larger (`GameGrid`/`GameCard`'s `size` prop);
  // the table gets the reordering but NOT a taller row — a dense list has no
  // room for a "featured" row without becoming noise.
  const sortedVisible = useMemo(() => {
    return [...visible].sort((a, b) => (a.status === 'playing' ? 0 : 1) - (b.status === 'playing' ? 0 : 1));
  }, [visible]);

  const counts = useMemo(() => {
    const byStatus = new Map<GameStatus, number>();
    for (const game of games) byStatus.set(game.status, (byStatus.get(game.status) ?? 0) + 1);
    return byStatus;
  }, [games]);

  const platformCounts = useMemo(() => {
    const byPlatform = new Map<GamePlatform, number>();
    for (const game of nonWantedGames) byPlatform.set(game.platform, (byPlatform.get(game.platform) ?? 0) + 1);
    return byPlatform;
  }, [nonWantedGames]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Library"
        subtitle={
          // Baseline is the NON-wanted count, not `games.length` — wanted
          // games are hidden by default, so the default view (no filter
          // touched) must read as "N games," not "N of M" against a total
          // that silently includes invisible wishlist rows.
          visible.length === nonWantedGames.length
            ? `${nonWantedGames.length} game${nonWantedGames.length === 1 ? '' : 's'}`
            : `${visible.length} of ${nonWantedGames.length} games`
        }
        actions={
          <>
            <div className="flex rounded-md border p-0.5">
              <Button
                variant={view === 'gallery' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7"
                aria-label="Gallery view"
                aria-pressed={view === 'gallery'}
                onClick={() => setView('gallery')}
              >
                <LayoutGrid className="size-4" />
              </Button>
              <Button
                variant={view === 'table' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7"
                aria-label="Table view"
                aria-pressed={view === 'table'}
                onClick={() => setView('table')}
              >
                <Rows3 className="size-4" />
              </Button>
            </div>

            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-4" />
              Add game
            </Button>

            <SyncButton configured={steamConfigured} />
            <PsnSyncButton configured={psnConfigured} />
          </>
        }
      />

      {/* Search sits on its own row, above the chips, at every breakpoint —
          rather than sharing one line with two chip groups that only wraps
          once it overflows. On a narrow viewport that shared-line layout let
          a chip group's own content (multiple platform names, each with a
          count) push the row wider before wrapping kicked in; stacking is
          the simplest layout that just holds up regardless of how many chips
          end up in play. */}
      <div className="space-y-2">
        <Input
          type="search"
          aria-label="Search games"
          placeholder="Search title, developer, publisher…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="h-8 w-full sm:max-w-64"
        />

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <div className="flex flex-wrap gap-1">
            {/* No "All" chip: an active chip toggles itself off, and the
                "Clear" control below appears whenever anything is filtered.
                Three "All …" chips that only ever restated the same total
                were the bulk of this row's clutter. */}
            {/* A status with zero games in the library is noise, not a real filter —
                same principle as the platform chips below. */}
            {GAME_STATUSES.filter((value) => (counts.get(value) ?? 0) > 0).map((value) => (
              <FilterChip
                key={value}
                label={STATUS_LABELS[value]}
                count={counts.get(value) ?? 0}
                active={status === value}
                onClick={() => setStatus(status === value ? 'all' : value)}
              />
            ))}
          </div>

          <div className="flex flex-wrap gap-1">
            {/* Only platforms the owner actually has games on — a zero-count chip
                like "PC 0" is noise the owner has to read past, not a useful
                filter (steam absorbs the real PC library; see PLATFORM_LABELS). */}
            {GAME_PLATFORMS.filter((value) => (platformCounts.get(value) ?? 0) > 0).map((value) => (
              <FilterChip
                key={value}
                label={PLATFORM_LABELS[value]}
                count={platformCounts.get(value) ?? 0}
                active={platform === value}
                onClick={() => setPlatform(platform === value ? 'all' : value)}
              />
            ))}
          </div>

          {/* Replaces the three "All …" chips that used to lead each group.
              They spent three permanent slots restating a total the header
              already prints, and one of them ("All sources") headed a group
              whose "Steam" chip meant something different from the "Steam /
              PC" platform chip beside it. This appears only when there is
              something to clear, so the row's resting state is just the
              filters themselves. */}
          {filtered ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground h-6 px-2 text-xs"
              onClick={() => {
                setStatus('all');
                setPlatform('all');
                setSearch('');
              }}
            >
              Clear
            </Button>
          ) : null}
        </div>
      </div>

      {games.length === 0 ? (
        <p className="text-muted-foreground py-16 text-center text-sm">
          No games yet. Add your first one to start the library.
        </p>
      ) : visible.length === 0 ? (
        <p className="text-muted-foreground py-16 text-center text-sm">
          No games match this filter.
        </p>
      ) : view === 'gallery' ? (
        <GameGrid games={sortedVisible} onOpen={setEditing} />
      ) : (
        <GameTable games={sortedVisible} onOpen={setEditing} />
      )}

      <GameDialog
        key={editing?.id ?? (creating ? 'create' : 'closed')}
        game={editing}
        open={creating || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
      />
    </div>
  );
}
