'use client';

import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { GripVertical } from 'lucide-react';
import { Fragment, useState } from 'react';

import { PlatinumBadge } from '@/components/games/platinum-badge';
import { RatingStars } from '@/components/games/rating-stars';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import type { Game } from '@/server/db/games/games';
import { type CollectionGroup, rollUpHours, rollUpTrophies } from '@/server/games/collections';
import { PLATFORM_LABELS } from '@/server/games/taxonomy';
import { gameTotals } from '@/server/games/dlc';
import { formatHours, hours } from '@/server/games/hours';

/** A collection row with each rolled-up figure in place of its own — see `rollUpHours`/`rollUpTrophies`. */
function rolledUp(game: Game, members: readonly Game[]): Game {
  const hoursSummary = rollUpHours(game, members);
  const trophies = rollUpTrophies(game, members);
  return {
    ...game,
    ...(hoursSummary.unsplit ? {} : { hoursTenths: hoursSummary.hoursTenths }),
    ...(trophies.unsplit
      ? {}
      : {
          achievementsUnlocked: trophies.unlocked,
          achievementsTotal: trophies.total,
          platinum: trophies.platinum,
        }),
  };
}

/**
 * The dense view — deliberately close to the spreadsheet this replaces, because
 * scanning and comparing 100 rows is a genuinely different task from browsing,
 * and a card grid is bad at it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ROW ACTIVATION IS A REAL BUTTON IN THE FIRST CELL, NOT `onClick` ON `<tr>`.
 *
 * `TableRow` keeps its `onClick` as a mouse-only convenience (click anywhere in
 * the row), but that alone leaves keyboard users with no way to open a game —
 * a `<tr>` is not natively focusable and giving it `role="button"` would strip
 * its implicit `row` semantics from screen readers, along with its cells'
 * `cell` semantics, for no real gain. A native `<button>` around the title gets
 * correct tab-order focus, a visible focus ring, and Enter/Space activation
 * for free from the browser — no `onKeyDown` hand-rolling needed — and its
 * accessible name (the title text) says exactly which game it opens.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * COLLECTIONS NEST, ONE LEVEL, EXACTLY AS THE SPREADSHEET DREW THEM.
 *
 * The source sheet put "Uncharted: The Nathan Drake Collection" on one line
 * and indented its three games under it, and that is the layout being
 * restored here: the collection row keeps the set's cover, hours, price and
 * trophies, and each title inside it gets its own indented row so the owner
 * can still see — and click into — all three.
 *
 * The indent is the ONLY thing carrying that relationship visually, which is
 * no use to a screen reader, so each member's button also carries an sr-only
 * " — in <collection>" suffix. The collection row's own "3 games" marker is
 * likewise real text, not a decorative chip: it is what tells you the row is
 * a wrapper rather than a game that happens to have three siblings.
 *
 * Members are NOT filtered out of the group when the collection itself
 * matches the active filter — see `library-view.tsx`, which decides that.
 * This component renders exactly the groups it is handed.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function GameTable({
  groups,
  activeId,
  onOpen,
  selectedIds,
  onToggleSelect,
  onReorder,
}: {
  readonly groups: readonly CollectionGroup<Game>[];
  /** The game the side panel is showing, if any — its row is highlighted. */
  readonly activeId: string | null;
  readonly onOpen: (game: Game) => void;
  /**
   * Selection is OFF unless both of these are supplied, so every existing
   * call site keeps a table with no checkbox column and rows that open on
   * click. Selecting and opening are different intents on the same row, and
   * a table that silently switched between them would be worse than one
   * that never offers selection at all.
   */
  readonly selectedIds?: readonly string[];
  readonly onToggleSelect?: (game: Game) => void;
  /**
   * Present exactly when the rows may be reordered (`library-view.tsx`). The
   * sortable unit is the GROUP — a collection row drags its indented titles
   * along — and the drag starts from a grip handle, never from the row, so a
   * row click and the selection checkbox keep their meanings.
   *
   * No row-shift animation here, on purpose: rows are `<tr>`s, and CSS
   * transforms on table rows are unreliable across browsers. Feedback is the
   * lifted ghost that follows the pointer and a 2px line on the row the drop
   * would land next to. The gallery is where the smooth version lives.
   */
  readonly onReorder?: (activeId: string, overId: string) => void;
}): React.ReactElement {
  const selectable = selectedIds !== undefined && onToggleSelect !== undefined;
  const sortable = onReorder !== undefined;
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const table = (
    <Table>
      <TableHeader>
        <TableRow>
          {sortable ? <TableHead className="w-8" /> : null}
          {selectable ? <TableHead className="w-8" /> : null}
          <TableHead>Title</TableHead>
          <TableHead>Platform</TableHead>
          <TableHead className="text-right">Hours</TableHead>
          <TableHead className="text-right">Year</TableHead>
          <TableHead className="text-right">Achievements</TableHead>
          <TableHead>Rating</TableHead>
          <TableHead>Platinum</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((group) => {
          const topLevel = {
            game: group.game,
            members: group.members,
            active: group.game.id === activeId,
            onOpen,
            ...(selectable
              ? { selected: selectedIds.includes(group.game.id), onToggleSelect }
              : {}),
          };
          return (
            <Fragment key={group.game.id}>
              {sortable ? <SortableGameRow {...topLevel} /> : <GameRow {...topLevel} />}
              {group.members.map((member) => (
                <GameRow
                  key={member.id}
                  game={member}
                  collectionTitle={group.game.title}
                  active={member.id === activeId}
                  onOpen={onOpen}
                  handleColumn={sortable}
                  {...(selectable
                    ? { selected: selectedIds.includes(member.id), onToggleSelect }
                    : {})}
                />
              ))}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );

  if (!sortable) return table;

  const dragging =
    draggingId === null ? null : groups.find((group) => group.game.id === draggingId);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={(event: DragStartEvent) => setDraggingId(String(event.active.id))}
      onDragCancel={() => setDraggingId(null)}
      onDragEnd={(event: DragEndEvent) => {
        setDraggingId(null);
        if (event.over !== null && event.over.id !== event.active.id) {
          onReorder(String(event.active.id), String(event.over.id));
        }
      }}
    >
      <SortableContext
        items={groups.map((group) => group.game.id)}
        strategy={verticalListSortingStrategy}
      >
        {table}
      </SortableContext>
      {/* A `<tr>` cannot live outside a table, so the ghost is a compact line
          of its own: the title and platform, enough to know what is in hand. */}
      <DragOverlay dropAnimation={null}>
        {dragging === null || dragging === undefined ? null : (
          <div className="bg-background rounded-md border px-3 py-2 text-sm shadow-lg">
            <span className="font-medium">{dragging.game.title}</span>
            <span className="text-muted-foreground ml-2 text-xs">
              {PLATFORM_LABELS[dragging.game.platform]}
              {dragging.members.length === 0 ? '' : ` · ${dragging.members.length} games`}
            </span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

/**
 * A top-level row that can be dragged: `useSortable` measures the `<tr>` and
 * reports when the drop would land beside it, and the grip is the only
 * activator. The transform dnd-kit computes is deliberately NOT applied —
 * see `GameTable`'s `onReorder` doc.
 */
function SortableGameRow(
  props: Omit<Parameters<typeof GameRow>[0], 'rowRef' | 'handleRef' | 'handle'>,
): React.ReactElement {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isOver, activeIndex, overIndex } =
    useSortable({ id: props.game.id, transition: null });
  const dropLine: 'above' | 'below' | null =
    isOver && activeIndex !== overIndex ? (activeIndex < overIndex ? 'below' : 'above') : null;

  return (
    <GameRow
      {...props}
      rowRef={setNodeRef}
      handleRef={setActivatorNodeRef}
      handle={{
        props: { ...attributes, ...listeners } as React.ButtonHTMLAttributes<HTMLButtonElement>,
        dropLine,
      }}
    />
  );
}

function GameRow({
  game,
  members = [],
  collectionTitle,
  active = false,
  onOpen,
  selected,
  onToggleSelect,
  rowRef,
  handleRef,
  handle,
  handleColumn = false,
}: {
  readonly game: Game;
  /** Non-empty when this row is a collection wrapper: the titles filed under it, for the roll-ups. */
  readonly members?: readonly Game[];
  /** dnd-kit's node ref for a sortable row — see `SortableGameRow`. */
  readonly rowRef?: (node: HTMLElement | null) => void;
  /** dnd-kit's activator ref for the grip. A prop of its own: the React Compiler lint reads a `ref` field inside an object as a ref box. */
  readonly handleRef?: (node: HTMLElement | null) => void;
  /** The grip handle's drag props, plus where a drop would land relative to this row. */
  readonly handle?: {
    readonly props: React.ButtonHTMLAttributes<HTMLButtonElement>;
    readonly dropLine: 'above' | 'below' | null;
  };
  /** A member row inside a sortable table: keeps the handle column's width with no handle in it. */
  readonly handleColumn?: boolean;
  /** Set when this row sits INSIDE a collection — indents it and names its parent for screen readers. */
  readonly collectionTitle?: string;
  /** This row's game is open in the side panel. */
  readonly active?: boolean;
  readonly onOpen: (game: Game) => void;
  /** Present only in selection mode — see `GameTable`'s own `selectable`. */
  readonly selected?: boolean;
  readonly onToggleSelect?: (game: Game) => void;
}): React.ReactElement {
  const nested = collectionTitle !== undefined;
  const selectable = selected !== undefined && onToggleSelect !== undefined;
  const memberCount = members.length;
  // A collection whose games carry their own hours or trophies shows the
  // roll-up (`rollUpHours`, `rollUpTrophies`) and its own lump otherwise —
  // the same figure its panel shows. Then base + DLC on top: the library
  // reads totals; only the panel shows the split.
  const base = memberCount === 0 ? game : rolledUp(game, members);
  const totals = gameTotals(base, game.dlc);

  return (
    <TableRow
      {...(rowRef ? { ref: rowRef } : {})}
      className={cn(
        'cursor-pointer',
        active && 'bg-muted/60',
        // The drop indicator: an inset line on the edge the dragged row would
        // land on. A box-shadow rather than a border so nothing reflows.
        handle?.dropLine === 'above' && 'shadow-[inset_0_2px_0_0_currentColor]',
        handle?.dropLine === 'below' && 'shadow-[inset_0_-2px_0_0_currentColor]',
      )}
      {...(active ? { 'data-active': true } : {})}
      // In selection mode the whole row toggles instead of navigating. Two
      // intents cannot share one click, and selection is the one you are
      // repeating — you turned the mode on to pick several rows, so it gets
      // the cheap gesture and the title link keeps navigation.
      onClick={() => (selectable ? onToggleSelect(game) : onOpen(game))}
      {...(selectable ? { 'data-selected': selected || undefined } : {})}
    >
      {handle ? (
        <TableCell className="w-8 pr-0">
          <button
            type="button"
            {...(handleRef ? { ref: handleRef } : {})}
            {...handle.props}
            aria-label={`Drag to reorder ${game.title}`}
            onClick={(event) => event.stopPropagation()}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring cursor-grab touch-none rounded-sm p-0.5 focus-visible:ring-2 focus-visible:outline-none active:cursor-grabbing"
          >
            <GripVertical className="size-4" />
          </button>
        </TableCell>
      ) : handleColumn ? (
        <TableCell className="w-8" />
      ) : null}
      {selectable ? (
        <TableCell className="w-8">
          <Checkbox
            checked={selected}
            aria-label={`Select ${game.title}`}
            onCheckedChange={() => onToggleSelect(game)}
            onClick={(event) => event.stopPropagation()}
          />
        </TableCell>
      ) : null}
      <TableCell className={cn('font-medium', nested && 'pl-8 font-normal')}>
        <button
          type="button"
          // An explicit label rather than an `sr-only` span beside the title:
          // the accessible name is computed by CONCATENATING child nodes with
          // each one trimmed, so a span reading " — in X" is announced as
          // "Remastered— in X", with the separator glued to the title. The
          // visible text stays a prefix of this label, so the two never
          // disagree (WCAG 2.5.3).
          {...(nested ? { 'aria-label': `${game.title} — in ${collectionTitle}` } : {})}
          onClick={(event) => {
            // The row above already handles click; stop the event reaching it
            // so a mouse click doesn't fire twice. The title always OPENS,
            // even in selection mode — otherwise turning selection on would
            // leave no way to reach a game's page from the table at all.
            event.stopPropagation();
            onOpen(game);
          }}
          className={cn(
            'rounded-md text-left focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
          )}
        >
          {game.title}
        </button>
        {memberCount === 0 ? null : (
          <span className="text-muted-foreground ml-2 text-xs">
            {memberCount} game{memberCount === 1 ? '' : 's'}
          </span>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground">{PLATFORM_LABELS[game.platform]}</TableCell>
      {/* A title inside a collection shows its OWN hours and trophies when it
          carries them, and "—" when the set still holds one unsplit figure on
          the row directly above. See `docs/GAMES.md`, "Collections." */}
      <TableCell className="tabular text-right">
        {totals.hoursTenths === null ? '—' : formatHours(hours(totals.hoursTenths))}
      </TableCell>
      <TableCell className="tabular text-right">{game.firstPlayedYear ?? '—'}</TableCell>
      <TableCell className="tabular text-right">
        {totals.achievementsUnlocked === null
          ? '—'
          : `${totals.achievementsUnlocked}${totals.achievementsTotal === null ? '' : ` / ${totals.achievementsTotal}`}`}
      </TableCell>
      <TableCell>
        {/* A collection has no rating of its own; the games inside it do. */}
        {memberCount === 0 ? <RatingStars rating={game.rating} /> : null}
      </TableCell>
      <TableCell>
        {/* PlatinumBadge is icon-only and aria-hidden by design (the
            card view folds its meaning into the card's own aria-label
            instead) — this sr-only text is the table view's own
            equivalent, since a table cell has no such wrapper to fold
            it into. */}
        {base.platinum ? (
          <span className="inline-flex items-center gap-1.5">
            <PlatinumBadge />
            <span className="sr-only">Platinum</span>
          </span>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
