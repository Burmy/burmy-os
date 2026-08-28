'use client';

import { Loader2 } from 'lucide-react';
import { Fragment } from 'react';

import { PlatinumBadge } from '@/components/games/platinum-badge';
import { RatingStars } from '@/components/games/rating-stars';
import { StatusBadge } from '@/components/games/status-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import type { Game } from '@/server/db/games/games';
import type { CollectionGroup } from '@/server/games/collections';
import { PLATFORM_LABELS } from '@/server/games/taxonomy';
import { formatHours, hours } from '@/server/games/hours';

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
  openingId,
  onOpen,
}: {
  readonly groups: readonly CollectionGroup<Game>[];
  /** The row whose navigation is in flight — see `GameCard`'s `opening` for why this exists. */
  readonly openingId: string | null;
  readonly onOpen: (game: Game) => void;
}): React.ReactElement {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
          <TableHead>Platform</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Hours</TableHead>
          <TableHead className="text-right">Year</TableHead>
          <TableHead className="text-right">Achievements</TableHead>
          <TableHead>Rating</TableHead>
          <TableHead>Platinum</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((group) => (
          <Fragment key={group.game.id}>
            <GameRow
              game={group.game}
              memberCount={group.members.length}
              opening={group.game.id === openingId}
              onOpen={onOpen}
            />
            {group.members.map((member) => (
              <GameRow
                key={member.id}
                game={member}
                collectionTitle={group.game.title}
                opening={member.id === openingId}
                onOpen={onOpen}
              />
            ))}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );
}

function GameRow({
  game,
  memberCount = 0,
  collectionTitle,
  opening = false,
  onOpen,
}: {
  readonly game: Game;
  /** Non-zero when this row is a collection wrapper. */
  readonly memberCount?: number;
  /** Set when this row sits INSIDE a collection — indents it and names its parent for screen readers. */
  readonly collectionTitle?: string;
  readonly opening?: boolean;
  readonly onOpen: (game: Game) => void;
}): React.ReactElement {
  const nested = collectionTitle !== undefined;

  return (
    <TableRow className="cursor-pointer" aria-busy={opening || undefined} onClick={() => onOpen(game)}>
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
            // The row above already opens on click; stop the event
            // reaching it so a mouse click doesn't call onOpen twice.
            event.stopPropagation();
            onOpen(game);
          }}
          className={cn(
            'rounded-md text-left focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
          )}
        >
          {game.title}
        </button>
        {opening ? (
          <Loader2 className="text-muted-foreground ml-2 inline size-3.5 animate-spin align-middle" aria-hidden />
        ) : null}
        {memberCount === 0 ? null : (
          <span className="text-muted-foreground ml-2 text-xs">
            {memberCount} game{memberCount === 1 ? '' : 's'}
          </span>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {PLATFORM_LABELS[game.platform]}
        {/* Same provenance mark as game-card.tsx, folded into the existing
            Platform cell rather than a new column — compact, and this is
            specifically "does Steam own this game's data," independent of
            the `platform` field itself (a `steam` platform game can still
            be unlinked). */}
        {game.steamAppid === null ? '' : ' · Steam'}
      </TableCell>
      <TableCell>
        <StatusBadge status={game.status} />
      </TableCell>
      {/* A title inside a collection reads "—" across Hours, Achievements and
          Platinum, and that is correct rather than missing data: the set has
          ONE play time and ONE trophy list, and they are on the row directly
          above. See `docs/GAMES.md`, "Collections." */}
      <TableCell className="tabular text-right">
        {game.hoursTenths === null ? '—' : formatHours(hours(game.hoursTenths))}
      </TableCell>
      <TableCell className="tabular text-right">{game.firstPlayedYear ?? '—'}</TableCell>
      <TableCell className="tabular text-right">
        {game.achievementsUnlocked === null
          ? '—'
          : `${game.achievementsUnlocked}${game.achievementsTotal === null ? '' : ` / ${game.achievementsTotal}`}`}
      </TableCell>
      <TableCell>
        <RatingStars rating={game.rating} />
      </TableCell>
      <TableCell>
        {/* PlatinumBadge is icon-only and aria-hidden by design (the
            card view folds its meaning into the card's own aria-label
            instead) — this sr-only text is the table view's own
            equivalent, since a table cell has no such wrapper to fold
            it into. */}
        {game.platinum ? (
          <span className="inline-flex items-center gap-1.5">
            <PlatinumBadge />
            <span className="sr-only">Platinum</span>
          </span>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
