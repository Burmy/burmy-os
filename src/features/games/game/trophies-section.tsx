'use client';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TrophyTierBadge } from '@/components/games/trophy-tier-badge';
import { formatRarity, type Trophy, type TrophyTier } from '@/server/games/trophies';

/**
 * The four states a live PSN trophy fetch can be in, owned by `GamePage`
 * (the fetch fires once, on the Trophies tab's first activation — see that
 * file) and rendered here. `'idle'`/`'loading'` collapse to the same
 * spinner: with `forceMount` keeping this tab's content mounted even while
 * inactive, `'idle'` is only ever visible for one render before the fetch
 * kicks off, never worth a separate treatment.
 */

const TIER_ORDER: Record<TrophyTier, number> = { platinum: 3, gold: 2, silver: 1, bronze: 0 };

/**
 * Rarest tier first, then by name. `tier` is null for Steam achievements,
 * which have no tier concept at all — those sort together below every PSN
 * tier rather than being given a fabricated rank, which is also the only
 * ordering that stays stable for a Steam-only game where EVERY row is null.
 */
function tierRank(tier: TrophyTier | null): number {
  return tier === null ? -1 : TIER_ORDER[tier];
}

function sortTrophies(trophies: readonly Trophy[]): Trophy[] {
  return [...trophies].sort(
    (a, b) => tierRank(b.tier) - tierRank(a.tier) || (a.name ?? '').localeCompare(b.name ?? ''),
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
export function TrophiesSection({ trophies }: { readonly trophies: readonly Trophy[] }): React.ReactElement {
  if (trophies.length === 0) {
    return (
      <p className="text-muted-foreground py-8 text-center text-sm">
        No trophies stored yet — run a sync from Settings to pull them in.
      </p>
    );
  }

  const earnedCount = trophies.filter((trophy) => trophy.earned).length;

  return (
    <div className="space-y-2">
      <p className="text-sm">
        <span className="tabular font-medium">{earnedCount}</span>
        <span className="text-muted-foreground"> of {trophies.length} trophies earned</span>
      </p>
      <TrophyList trophies={sortTrophies(trophies)} />
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
            // The earned row sits on a raised surface, so a 50-row list
            // scans as blocks of "done" rather than making the reader
            // compare two badge shades. The grayscale badge on unearned
            // rows stays too — the two signals reinforce rather than
            // replace each other.
            <TableRow key={trophy.id} className={trophy.earned ? 'bg-card' : undefined}>
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
                  : (formatRarity(trophy.rarityTenths) ?? '—')}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
