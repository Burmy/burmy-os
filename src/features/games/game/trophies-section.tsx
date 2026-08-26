'use client';

import { motion } from 'motion/react';

import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TrophyTierBadge } from '@/components/games/trophy-tier-badge';
import type { PsnFailure } from '@/server/db/games/psn-client';
import type { Trophy, TrophyTier } from '@/server/games/psn';

/**
 * The four states a live PSN trophy fetch can be in, owned by `GamePage`
 * (the fetch fires once, on the Trophies tab's first activation — see that
 * file) and rendered here. `'idle'`/`'loading'` collapse to the same
 * spinner: with `forceMount` keeping this tab's content mounted even while
 * inactive, `'idle'` is only ever visible for one render before the fetch
 * kicks off, never worth a separate treatment.
 */
export type TrophyFetchState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly trophies: readonly Trophy[] }
  | { readonly status: 'failed'; readonly reason: PsnFailure | 'not_linked' };

const FAILURE_MESSAGES: Record<PsnFailure | 'not_linked', string> = {
  not_configured: "PlayStation isn't connected — set PSN_NPSSO to enable trophy tracking.",
  token_expired: 'Your PlayStation connection needs refreshing — paste a new NPSSO in Settings.',
  unavailable: "Couldn't reach PlayStation right now. Try again in a moment.",
  not_linked: 'This game isn\'t linked to PlayStation Network.',
};

const TIER_ORDER: Record<TrophyTier, number> = { platinum: 3, gold: 2, silver: 1, bronze: 0 };

function sortTrophies(trophies: readonly Trophy[]): Trophy[] {
  return [...trophies].sort(
    (a, b) => TIER_ORDER[b.tier] - TIER_ORDER[a.tier] || (a.name ?? '').localeCompare(b.name ?? ''),
  );
}

function formatEarnedDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Live PSN trophy detail for one game — same data PSNProfiles shows, in
 * this app's own flat/minimal style rather than a visual clone. No banner
 * art, no community stats bar: PSNProfiles' site-wide "owners"/"recent
 * players" figures come from its own crawled community database, not
 * something Sony's official API exposes to a single account.
 *
 * One merged list, sorted tier-then-name — not split into separate Earned/
 * Unearned tables. Color alone (full tier color vs. grayed-out) signals
 * earned/unearned; real usage found two headed tables read as more
 * structure than the data actually needed.
 *
 * v1 scope discipline: no DLC-group labeling — `Trophy.groupId` is captured
 * for a later pass, but a human-readable group name needs a third,
 * unrequested API call (`getTitleTrophyGroups`).
 */
export function TrophiesSection({ state }: { readonly state: TrophyFetchState }): React.ReactElement {
  if (state.status === 'idle' || state.status === 'loading') return <TrophyListSkeleton />;

  if (state.status === 'failed') {
    return <p className="text-muted-foreground py-8 text-center text-sm">{FAILURE_MESSAGES[state.reason]}</p>;
  }

  if (state.trophies.length === 0) {
    return <p className="text-muted-foreground py-8 text-center text-sm">No trophy data found for this game.</p>;
  }

  const earnedCount = state.trophies.filter((trophy) => trophy.earned).length;

  return (
    <motion.div
      className="space-y-2"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
    >
      <p className="text-sm">
        <span className="tabular font-medium">{earnedCount}</span>
        <span className="text-muted-foreground"> of {state.trophies.length} trophies earned</span>
      </p>
      <TrophyList trophies={sortTrophies(state.trophies)} />
    </motion.div>
  );
}

/** Content-shaped placeholder for the fetch, in place of a bare spinner. */
function TrophyListSkeleton(): React.ReactElement {
  return (
    <div className="space-y-2">
      <Skeleton className="h-5 w-40" />
      <div className="space-y-1">
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="flex items-center gap-3 py-2">
            <Skeleton className="size-6 shrink-0 rounded-md" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-1/3" />
              <Skeleton className="h-3 w-2/3" />
            </div>
            <Skeleton className="h-3 w-16 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}

function TrophyList({ trophies }: { readonly trophies: readonly Trophy[] }): React.ReactElement {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10" />
          <TableHead>Trophy</TableHead>
          <TableHead className="text-right">Earned / Rarity</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {trophies.map((trophy) => {
          // Redacted for a still-secret trophy — avoids spoiling a hidden
          // trophy's name/description before the owner has earned it,
          // matching how PSN's own clients treat this exact flag.
          const redact = trophy.hidden && !trophy.earned;
          return (
            <TableRow key={trophy.id}>
              <TableCell>
                {/* Full tier color once earned; grayed/desaturated until
                    then — the same visual language the PlayStation app
                    itself uses, so color alone (not a second Earned/
                    Unearned table) carries the earned/unearned signal in
                    this one merged list. */}
                <span className={trophy.earned ? undefined : 'opacity-50 grayscale'}>
                  <TrophyTierBadge tier={trophy.tier} />
                </span>
              </TableCell>
              <TableCell className={trophy.earned ? undefined : 'text-muted-foreground'}>
                <div className="font-medium">{redact ? '???' : (trophy.name ?? 'Untitled trophy')}</div>
                {redact || trophy.description === null ? null : (
                  <div className="text-muted-foreground text-xs">{trophy.description}</div>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground tabular text-right text-xs">
                {trophy.earned && trophy.earnedAt !== null
                  ? formatEarnedDate(trophy.earnedAt)
                  : trophy.rarity !== null
                    ? `${trophy.rarity}%`
                    : '—'}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
