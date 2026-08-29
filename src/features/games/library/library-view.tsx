'use client';

import Link from 'next/link';
import { Copy, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { FilterBar, FilterField } from '@/components/ui/filter-bar';
import { FilterChip } from '@/components/ui/filter-chip';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SegmentedToggle } from '@/components/ui/segmented-toggle';
import { useNavigate } from '@/lib/use-navigate';
import type { Game } from '@/server/db/games/games';
import { countableGames, groupByCollection } from '@/server/games/collections';
import { GAME_PLATFORMS, PLATFORM_LABELS, STATUS_LABELS } from '@/server/games/taxonomy';
import type { GamePlatform, GameStatus } from '@/server/games/taxonomy';
import { toast } from '@/components/ui/toast';
import { addGamesToCollectionAction } from '@/features/games/game-actions';
import { BulkCollectionBar } from './bulk-collection-bar';
import { GameDialog } from './game-dialog';
import { GameGrid } from './game-grid';
import { GameTable } from './game-table';

type ViewMode = 'gallery' | 'table';
type StatusFilter = GameStatus | 'all';
type PlatformFilter = GamePlatform | 'all';
// Only `wanted` earns a status chip. `played` is the majority-default state
// for ~95% of the library and `playing` covers at most one game at a time, so
// neither is a useful library-wide filter; `backlog` was dropped after real
// use — it wasn't a bucket the owner actually filtered by. `wanted` has to
// stay regardless of usefulness as a filter, because wishlist games are
// HIDDEN from the default view and this chip is the only way to see them.
const STATUS_CHIP_STATUSES = ['wanted'] as const satisfies readonly GameStatus[];
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
  duplicateCount = 0,
}: {
  readonly games: readonly Game[];
  /** Pairs the Duplicates screen has something to say about — the link is hidden at 0. */
  readonly duplicateCount?: number;
}): React.ReactElement {
  // Opening a game is a full cross-segment navigation with a database read at
  // the other end, and the card gave no sign it had been clicked — the wall of
  // covers just sat there. `openingId` is what the clicked card/row renders a
  // spinner from; it is cleared implicitly when `pending` goes false, so there
  // is no stale id to reset. See `useNavigate`.
  const { navigate, pending: opening } = useNavigate();
  const [openingId, setOpeningId] = useState<string | null>(null);

  function open(game: Game): void {
    setOpeningId(game.id);
    navigate(`/games/${game.id}`);
  }

  const [view, setView] = useState<ViewMode>('gallery');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [platform, setPlatform] = useState<PlatformFilter>('all');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);

  /**
   * MULTI-SELECT IS TABLE-ONLY, DELIBERATELY.
   *
   * The gallery's cards are already navigation buttons and its job is
   * browsing covers; the table is the dense, filterable view where you go to
   * clean something up — search "uncharted", see the seven rows, file three
   * of them. Adding a second click meaning to the cards would change what a
   * cover does depending on a mode, for a workflow nobody does from the
   * gallery. Switching to Gallery therefore clears the selection rather than
   * hiding it, so there is never a selection the owner cannot see.
   */
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);

  function toggleSelect(game: Game): void {
    setSelectedIds((current) =>
      current.includes(game.id) ? current.filter((id) => id !== game.id) : [...current, game.id],
    );
  }

  function changeView(next: ViewMode): void {
    if (next !== 'table') setSelectedIds([]);
    setView(next);
  }

  /**
   * What the selection can be filed INTO. Excludes the selected rows
   * themselves (a game cannot contain itself) and anything already inside a
   * collection (the one-level rule) — the same three exclusions
   * `listCollectionCandidates` applies on the server, which validates every
   * id again regardless of what this list offers.
   */
  const collectionTargets = useMemo(() => {
    const memberIds = new Set(games.filter((g) => g.collectionId !== null).map((g) => g.id));
    return games
      .filter((game) => !selectedIds.includes(game.id) && game.collectionId === null && !memberIds.has(game.id))
      .map((game) => ({ id: game.id, title: game.title, subtitle: PLATFORM_LABELS[game.platform] }));
  }, [games, selectedIds]);

  async function addSelectedTo(collectionId: string): Promise<void> {
    const target = games.find((game) => game.id === collectionId);
    const count = selectedIds.length;
    const result = await addGamesToCollectionAction(collectionId, selectedIds);

    if (result.ok) {
      setSelectedIds([]);
      toast.success(`${count} game${count === 1 ? '' : 's'} added to ${target?.title ?? 'the collection'}`);
      return;
    }
    toast.error(result.error);
  }

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

  /**
   * Both views render the same two-level shape: top-level rows, each carrying
   * the titles filed under it (`collections.ts`). The gallery draws one card
   * per group; the table indents the members under their collection.
   *
   * TWO RULES ABOUT WHICH SIDE OF A GROUP A FILTER APPLIES TO:
   *
   *   - A group survives if the collection itself matches OR any title inside
   *     it does. Otherwise searching "Drake's Fortune" would find nothing at
   *     all in the gallery, where that title has no card of its own.
   *   - When the collection matches, its members are NOT re-filtered — the
   *     whole set matched, so the whole set shows. This is also what keeps
   *     `visibleCount` below honest: a matching group always contributes at
   *     least one countable title.
   */
  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matches = (game: Game): boolean => {
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
    };

    return groupByCollection(games)
      .map((group) => ({
        game: group.game,
        members: matches(group.game) ? group.members : group.members.filter(matches),
      }))
      .filter((group) => matches(group.game) || group.members.length > 0);
  }, [games, status, platform, search]);

  // TITLES, not rows — the collection counting rule (`collections.ts`). A
  // group with members contributes its titles; a standalone game contributes
  // itself. So the header agrees with the Games dashboard's own total, and a
  // three-game boxed set reads as three games in both places, exactly as the
  // source spreadsheet counted it.
  const visibleCount = useMemo(
    () => groups.reduce((total, group) => total + (group.members.length || 1), 0),
    [groups],
  );
  const totalCount = useMemo(() => countableGames(nonWantedGames).length, [nonWantedGames]);

  const counts = useMemo(() => {
    const byStatus = new Map<GameStatus, number>();
    for (const game of games) byStatus.set(game.status, (byStatus.get(game.status) ?? 0) + 1);
    return byStatus;
  }, [games]);

  // Also titles rather than rows, for the same reason — a collection's own
  // platform would otherwise be counted alongside each of its titles', which
  // is the double-count the whole rule exists to prevent.
  const platformCounts = useMemo(() => {
    const byPlatform = new Map<GamePlatform, number>();
    for (const game of countableGames(nonWantedGames)) {
      byPlatform.set(game.platform, (byPlatform.get(game.platform) ?? 0) + 1);
    }
    return byPlatform;
  }, [nonWantedGames]);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Library"
        // Baseline is the NON-wanted count, not `games.length` — wanted games
        // are hidden by default, so the default view (no filter touched) must
        // read as "N games," not "N of M" against a total that silently
        // includes invisible wishlist rows.
        meta={
          <span>
            {visibleCount === totalCount
              ? `${totalCount} game${totalCount === 1 ? '' : 's'}`
              : `${visibleCount} of ${totalCount} games`}
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            {/* Only when there is something to fix. A permanent entry point
                reading "0 duplicates" on a clean library is an invitation to
                an empty page. */}
            {duplicateCount > 0 ? (
              <Button variant="outline" asChild>
                <Link href="/games/duplicates">
                  <Copy className="size-4" />
                  {duplicateCount} duplicate{duplicateCount === 1 ? '' : 's'}
                </Link>
              </Button>
            ) : null}
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" />
              Add game
            </Button>
          </div>
        }
      />

      {/* Search sits on its own row, above the chips, at every breakpoint —
          rather than sharing one line with two chip groups that only wraps
          once it overflows. On a narrow viewport that shared-line layout let
          a chip group's own content (multiple platform names, each with a
          count) push the row wider before wrapping kicked in; stacking is
          the simplest layout that just holds up regardless of how many chips
          end up in play.

          Status and platform stay CHIPS rather than becoming selects: both
          have a handful of known options and a count worth seeing without
          opening anything — that's the app's rule for which filters are
          chips and which are dropdowns (see `filter-bar.tsx`). */}
      {/* Filters left, display-mode toggle right — the same row shape
          Finance's Period + Month/This Year row uses. Search and the chips
          share that left group rather than stacking: the chips are filters
          too, so they belong on the filter side of the row, not on a line
          of their own. */}
      <FilterBar className="justify-between">
        <div className="flex flex-wrap items-end gap-3">
          <FilterField label="Search">
            <Input
              type="search"
              aria-label="Search games"
              placeholder="Search title, developer, publisher…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="w-full sm:w-64"
            />
          </FilterField>

          {/* ONE flat container, one gap. Status and platform chips used to
              sit in two separate groups with 12px between the groups and 4px
              inside them, which read as an unexplained gap in the middle of
              the row rather than as two categories. They are all just chips
              you can toggle; nothing about them needed grouping. */}
          <div className="flex flex-wrap items-center gap-2">
            {/* No "All" chip: an active chip toggles itself off, and the
                "Clear" control appears whenever anything is filtered. Three
                "All …" chips that only ever restated the same total were the
                bulk of this row's clutter. A zero-count chip is noise too —
                hence the filters on both lists. */}
            {STATUS_CHIP_STATUSES.filter((value) => (counts.get(value) ?? 0) > 0).map((value) => (
              <FilterChip
                key={value}
                label={STATUS_LABELS[value]}
                count={counts.get(value) ?? 0}
                active={status === value}
                onClick={() => setStatus(status === value ? 'all' : value)}
              />
            ))}

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
              className="text-muted-foreground"
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

        <SegmentedToggle
          value={view}
          onChange={changeView}
          options={[
            { value: 'gallery', label: 'Gallery' },
            { value: 'table', label: 'Table' },
          ]}
        />
      </FilterBar>

      {/* Only once something is selected. A permanently visible bar would
          take a strip of the screen to say "0 selected" for the entire time
          the owner is doing anything else. */}
      {selectedIds.length > 0 ? (
        <BulkCollectionBar
          selectedCount={selectedIds.length}
          collections={collectionTargets}
          onClear={() => setSelectedIds([])}
          onAdd={addSelectedTo}
        />
      ) : null}

      {games.length === 0 ? (
        <p className="text-muted-foreground py-16 text-center text-sm">
          No games yet. Add your first one to start the library.
        </p>
      ) : groups.length === 0 ? (
        <p className="text-muted-foreground py-16 text-center text-sm">
          No games match this filter.
        </p>
      ) : view === 'gallery' ? (
        <GameGrid groups={groups} openingId={opening ? openingId : null} onOpen={open} />
      ) : (
        <GameTable
          groups={groups}
          openingId={opening ? openingId : null}
          onOpen={open}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
        />
      )}

      <GameDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
