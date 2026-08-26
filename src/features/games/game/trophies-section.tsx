'use client';

import { Loader2 } from 'lucide-react';

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
 * v1 scope discipline: no DLC-group labeling — `Trophy.groupId` is captured
 * for a later pass, but a human-readable group name needs a third,
 * unrequested API call (`getTitleTrophyGroups`). One flat list per bucket,
 * sorted tier-then-name, is enough for now.
 */
export function TrophiesSection({ state }: { readonly state: TrophyFetchState }): React.ReactElement {
  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <p className="text-muted-foreground flex items-center justify-center gap-1.5 py-8 text-sm">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading trophies…
      </p>
    );
  }

  if (state.status === 'failed') {
    return <p className="text-muted-foreground py-8 text-center text-sm">{FAILURE_MESSAGES[state.reason]}</p>;
  }

  if (state.trophies.length === 0) {
    return <p className="text-muted-foreground py-8 text-center text-sm">No trophy data found for this game.</p>;
  }

  const earned = state.trophies.filter((trophy) => trophy.earned);
  const unearned = state.trophies.filter((trophy) => !trophy.earned);

  return (
    <div className="space-y-6">
      <p className="text-sm">
        <span className="tabular font-medium">{earned.length}</span>
        <span className="text-muted-foreground"> of {state.trophies.length} trophies earned</span>
      </p>
      {earned.length > 0 ? <TrophyList title="Earned" trophies={sortTrophies(earned)} /> : null}
      {unearned.length > 0 ? <TrophyList title="Unearned" trophies={sortTrophies(unearned)} /> : null}
    </div>
  );
}

function TrophyList({ title, trophies }: { readonly title: string; readonly trophies: readonly Trophy[] }): React.ReactElement {
  return (
    <div className="space-y-2">
      <h3 className="text-muted-foreground text-xs font-medium">
        {title} <span className="tabular">({trophies.length})</span>
      </h3>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10" />
            <TableHead>Trophy</TableHead>
            <TableHead className="text-right">{title === 'Earned' ? 'Earned' : 'Rarity'}</TableHead>
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
                  <TrophyTierBadge tier={trophy.tier} />
                </TableCell>
                <TableCell>
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
    </div>
  );
}
