'use client';

import Image from 'next/image';
import Link from 'next/link';
import { Loader2, Plus, X } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { StatusBadge } from '@/components/games/status-badge';
import { RatingStars } from '@/components/games/rating-stars';
import type { CollectionMember } from '@/server/db/games/games';
import { PLATFORM_LABELS } from '@/server/games/taxonomy';
import { addGamesToCollectionAction, updateGameCollectionAction } from '@/features/games/game-actions';
import { GamePickerDialog, type PickableGame } from './game-picker-dialog';

/**
 * The games inside a collection, now editable from the collection's own side.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY MEMBERSHIP IS EDITABLE FROM BOTH ENDS.
 *
 * The only way to build a set used to be to open each title in turn and set
 * its "Part of" field. That is the right control when you are looking at one
 * game and know where it belongs — but assembling a boxed set is the opposite
 * task: you are looking at the SET and know which titles go in it. Forcing
 * that job through the per-game field means three page loads to file three
 * games, and you have to remember the collection's exact name each time.
 *
 * Both directions write the same column through the same validation, so
 * neither is a shortcut around the one-level rule.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Each row still shows only what genuinely belongs to the individual game —
 * its art, platform, year and the owner's rating. Hours, price and (for now)
 * trophies live on the collection and describe the whole set; repeating them
 * per row would either be a lie or a blank column on every line.
 */
export function CollectionMembersPanel({
  collectionId,
  collectionTitle,
  members,
  candidates,
}: {
  readonly collectionId: string;
  readonly collectionTitle: string;
  readonly members: readonly CollectionMember[];
  /** Games that could be added — see `listCollectionCandidates` for the three exclusions. */
  readonly candidates: readonly PickableGame[];
}): React.ReactElement {
  const [picking, setPicking] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const memberIds = members.map((member) => member.id);

  async function add(ids: readonly string[]): Promise<void> {
    // The picker shows current members checked, so a confirm can carry ids
    // that are already in. The action treats those as a no-op, but filtering
    // here keeps the toast count honest about what actually changed.
    const added = ids.filter((id) => !memberIds.includes(id));
    if (added.length === 0) return;

    const result = await addGamesToCollectionAction(collectionId, added);
    if (result.ok) {
      toast.success(`${added.length} game${added.length === 1 ? '' : 's'} added to ${collectionTitle}`);
      return;
    }
    toast.error(result.error);
  }

  async function remove(member: CollectionMember): Promise<void> {
    setRemovingId(member.id);
    const result = await updateGameCollectionAction(member.id, null);
    setRemovingId(null);

    if (result.ok) {
      // Says where the game went, not just that something happened: "removed"
      // on its own reads like a deletion, and this does not delete anything.
      toast.success(`${member.title} is now a standalone game`);
      return;
    }
    toast.error(result.error);
  }

  return (
    <>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-muted-foreground text-xs font-medium">Games in this collection</h2>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground text-xs">
            {members.length} game{members.length === 1 ? '' : 's'}
          </span>
          <Button size="sm" variant="outline" onClick={() => setPicking(true)}>
            <Plus className="size-3.5" aria-hidden />
            Add games
          </Button>
        </div>
      </div>

      {members.length === 0 ? (
        <p className="text-muted-foreground bg-card rounded-md px-4 py-6 text-sm">
          Nothing in this collection yet. Add the titles the set contains and they&apos;ll count
          individually in your library.
        </p>
      ) : (
        <ul className="bg-card divide-y rounded-md px-4">
          {members.map((member) => (
            <li key={member.id} className="flex items-center gap-1">
              <Link
                href={`/games/${member.id}`}
                className="hover:bg-muted/50 -mx-2 flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors"
              >
                <span className="bg-muted relative h-12 w-9 shrink-0 overflow-hidden rounded-md">
                  {member.coverUrl === null ? (
                    <span
                      className="text-muted-foreground/50 flex h-full items-center justify-center text-xs font-semibold"
                      aria-hidden
                    >
                      {member.title.trim().charAt(0).toUpperCase()}
                    </span>
                  ) : (
                    <Image src={member.coverUrl} alt="" fill sizes="36px" className="object-cover" />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate">{member.title}</span>
                <span className="text-muted-foreground shrink-0 text-xs">{PLATFORM_LABELS[member.platform]}</span>
                {member.firstPlayedYear === null ? null : (
                  <span className="text-muted-foreground shrink-0 text-xs">{member.firstPlayedYear}</span>
                )}
                <StatusBadge status={member.status} />
                {member.rating === null ? null : <RatingStars rating={member.rating} />}
              </Link>

              <Button
                variant="ghost"
                size="icon"
                // Named, not just "Remove": with three near-identical Uncharted
                // rows, a bare label makes every button in the list read the
                // same to a screen reader.
                aria-label={`Remove ${member.title} from ${collectionTitle}`}
                onClick={() => void remove(member)}
                disabled={removingId !== null}
                className="size-8 shrink-0"
              >
                {removingId === member.id ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <X className="size-3.5" aria-hidden />
                )}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <GamePickerDialog
        open={picking}
        onOpenChange={setPicking}
        multiple
        title={`Add games to ${collectionTitle}`}
        description="Titles already in another collection aren't listed — remove them there first."
        games={candidates}
        selectedIds={memberIds}
        confirmLabel="Add to collection"
        emptyMessage="No game matches that search."
        onConfirm={add}
      />
    </>
  );
}
