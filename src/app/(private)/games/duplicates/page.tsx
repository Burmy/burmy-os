import type { Metadata } from 'next';
import Link from 'next/link';

import {
  DuplicatesView,
  type DuplicatePair,
  type DuplicateSide,
} from '@/features/games/duplicates/duplicates-view';
import { requireOwner } from '@/server/auth/owner';
import { listDuplicateCandidates } from '@/server/db/games/duplicates';
import {
  type DuplicateCandidate,
  type MergePlan,
  describeFills,
  findDuplicates,
  isSynced,
} from '@/server/games/duplicates';
import { formatHours, hours } from '@/server/games/hours';

export const metadata: Metadata = { title: 'Duplicates — Burmy' };

/**
 * The facts shown on each side of a pair.
 *
 * Only fields that are actually SET appear, so the two cards read as "here is
 * what this row knows" rather than as a form with blanks. Money and hours are
 * formatted here, on the server, through the same helpers the rest of Games
 * uses — the view does no game maths of its own.
 */
function factsFor(row: DuplicateCandidate): DuplicateSide['facts'] {
  const facts: { label: string; value: string }[] = [];

  if (row.hoursTenths !== null) facts.push({ label: 'Hours', value: formatHours(hours(row.hoursTenths)) });
  if (row.priceCents !== null) facts.push({ label: 'Price', value: `$${(row.priceCents / 100).toFixed(2)}` });
  if (row.rating !== null) facts.push({ label: 'Rating', value: '★'.repeat(row.rating) });
  if (row.achievementsUnlocked !== null) {
    facts.push({
      label: 'Achievements',
      value:
        row.achievementsTotal === null
          ? String(row.achievementsUnlocked)
          : `${row.achievementsUnlocked} / ${row.achievementsTotal}`,
    });
  }
  if (row.platinum) facts.push({ label: 'Platinum', value: 'Yes' });
  if (row.firstPlayedYear !== null) facts.push({ label: 'Year', value: String(row.firstPlayedYear) });
  if (row.genre !== null) facts.push({ label: 'Genre', value: row.genre });

  return facts;
}

function sideFor(row: DuplicateCandidate): DuplicateSide {
  return {
    title: row.title,
    platform: row.platform,
    synced: isSynced(row),
    facts: factsFor(row),
  };
}

function toPair(plan: MergePlan): DuplicatePair {
  return {
    winnerId: plan.winner.id,
    loserId: plan.loser.id,
    reason: plan.reason,
    summary: describeFills(plan),
    platforms: plan.platforms,
    createsMember: plan.createsMember,
    winner: sideFor(plan.winner),
    loser: sideFor(plan.loser),
  };
}

/**
 * The duplicates screen — the in-app replacement for
 * `scripts/merge-duplicate-games.mjs`.
 *
 * The script keys on `platform + title`, so it cannot see the owner's actual
 * duplicate (the same game on PS4 and PS5), and it runs against a database
 * from a terminal with no way to look at a pair before it writes. This page
 * detects both kinds, shows each pair whole, and writes nothing until one is
 * confirmed. The script stays for a bulk pass over a local copy.
 */
export default async function DuplicatesPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();

  const { rows, holdsMembers, hasTrophies } = await listDuplicateCandidates(owner.userId);
  const { merges, review } = findDuplicates(rows, { holdsMembers, hasTrophies });

  return (
    <div>
      <Link href="/games/library" className="text-muted-foreground hover:text-foreground text-sm">
        ← Library
      </Link>
      <div className="mt-2">
        <DuplicatesView
          pairs={merges.map(toPair)}
          notes={review.map((entry) => ({ titles: entry.titles, reason: entry.reason }))}
        />
      </div>
    </div>
  );
}
