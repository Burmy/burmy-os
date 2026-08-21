'use client';

import { LayoutGrid, Plus, Rows3 } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { Game } from '@/server/db/games/games';
import { GAME_PLATFORMS, GAME_STATUSES, PLATFORM_LABELS, STATUS_LABELS } from '@/server/games/taxonomy';
import type { GamePlatform, GameStatus } from '@/server/games/taxonomy';
import { GameDialog } from './game-dialog';
import { GameGrid } from './game-grid';
import { GameTable } from './game-table';

type ViewMode = 'gallery' | 'table';
type StatusFilter = GameStatus | 'all';
type PlatformFilter = GamePlatform | 'all';

/**
 * The library screen. Owns view mode, status filter, platform filter, and
 * search — all client state, because every one of them is a pure re-render of
 * data already loaded, and round-tripping to the server to hide a card would
 * be latency for nothing.
 */
export function LibraryView({ games }: { readonly games: readonly Game[] }): React.ReactElement {
  const [view, setView] = useState<ViewMode>('gallery');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [platform, setPlatform] = useState<PlatformFilter>('all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Game | null>(null);
  const [creating, setCreating] = useState(false);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return games.filter((game) => {
      if (status !== 'all' && game.status !== status) return false;
      if (platform !== 'all' && game.platform !== platform) return false;
      if (needle === '') return true;
      return (
        game.title.toLowerCase().includes(needle) ||
        (game.developer ?? '').toLowerCase().includes(needle) ||
        (game.publisher ?? '').toLowerCase().includes(needle)
      );
    });
  }, [games, status, platform, search]);

  const counts = useMemo(() => {
    const byStatus = new Map<GameStatus, number>();
    for (const game of games) byStatus.set(game.status, (byStatus.get(game.status) ?? 0) + 1);
    return byStatus;
  }, [games]);

  const platformCounts = useMemo(() => {
    const byPlatform = new Map<GamePlatform, number>();
    for (const game of games) byPlatform.set(game.platform, (byPlatform.get(game.platform) ?? 0) + 1);
    return byPlatform;
  }, [games]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Library</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {visible.length === games.length
              ? `${games.length} game${games.length === 1 ? '' : 's'}`
              : `${visible.length} of ${games.length} games`}
          </p>
        </div>

        <div className="flex items-center gap-2">
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
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          aria-label="Search games"
          placeholder="Search title, developer, publisher…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="h-8 max-w-64"
        />

        <div className="flex flex-wrap gap-1">
          <FilterChip label="All" count={games.length} active={status === 'all'} onClick={() => setStatus('all')} />
          {/* A status with zero games in the library is noise, not a real filter —
              same principle as the platform chips below. */}
          {GAME_STATUSES.filter((value) => (counts.get(value) ?? 0) > 0).map((value) => (
            <FilterChip
              key={value}
              label={STATUS_LABELS[value]}
              count={counts.get(value) ?? 0}
              active={status === value}
              onClick={() => setStatus(value)}
            />
          ))}
        </div>

        <div className="flex flex-wrap gap-1">
          <FilterChip
            label="All platforms"
            count={games.length}
            active={platform === 'all'}
            onClick={() => setPlatform('all')}
          />
          {/* Only platforms the owner actually has games on — a zero-count chip
              like "PC 0" is noise the owner has to read past, not a useful
              filter (steam absorbs the real PC library; see PLATFORM_LABELS). */}
          {GAME_PLATFORMS.filter((value) => (platformCounts.get(value) ?? 0) > 0).map((value) => (
            <FilterChip
              key={value}
              label={PLATFORM_LABELS[value]}
              count={platformCounts.get(value) ?? 0}
              active={platform === value}
              onClick={() => setPlatform(value)}
            />
          ))}
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
        <GameGrid games={visible} onOpen={setEditing} />
      ) : (
        <GameTable games={visible} onOpen={setEditing} />
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

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  readonly label: string;
  readonly count: number;
  readonly active: boolean;
  readonly onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        active ? 'bg-foreground text-background border-transparent' : 'text-muted-foreground hover:bg-muted',
      )}
    >
      {label}
      <span className="ml-1.5 opacity-60">{count}</span>
    </button>
  );
}
