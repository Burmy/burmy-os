'use client';

import { AlertTriangle, ArrowRight, Check, Loader2 } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { Section } from '@/components/ui/section';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { PLATFORM_LABELS, type GamePlatform } from '@/server/games/taxonomy';
import { mergeDuplicateAction } from './duplicate-actions';

/**
 * What the screen needs per pair. A serialisable projection built on the
 * server, not the `MergePlan` itself — that carries two whole rows, most of
 * which never reaches the page.
 */
export interface DuplicatePair {
  readonly winnerId: string;
  readonly loserId: string;
  readonly reason: string;
  readonly summary: string;
  readonly platforms: readonly GamePlatform[];
  /** A title the merge will CREATE inside the collection, or null — see `MergePlan.createsMember`. */
  readonly createsMember: string | null;
  readonly winner: DuplicateSide;
  readonly loser: DuplicateSide;
}

export interface DuplicateSide {
  readonly title: string;
  readonly platform: GamePlatform;
  readonly synced: boolean;
  /** Label/value pairs, already formatted — the page does no game maths. */
  readonly facts: readonly { readonly label: string; readonly value: string }[];
}

export interface DuplicateNote {
  readonly titles: readonly string[];
  readonly reason: string;
}

/**
 * The duplicates screen.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOTHING HAPPENS UNTIL A PAIR IS CONFIRMED, AND EVERY PAIR IS SHOWN WHOLE.
 *
 * This is the only screen in the app that deletes a game, so it is built
 * around showing the owner exactly what they are about to lose rather than
 * around getting through the list quickly. Both rows side by side, both sets
 * of figures, an explicit statement of what carries across, and the platform
 * as a choice rather than a rule — because the owner's own case (a PS4
 * purchase played on PS5) and a genuine two-product case (`psn.ts` documents
 * the same account holding Cyberpunk as both CUSA and PPSA) look identical
 * from here.
 *
 * The "needs your decision" list below the merges is not a failure log. Those
 * are pairs where the data does not force an answer — three rows sharing a
 * title, both copies synced — and quietly dropping them would leave the owner
 * believing the library was clean.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function DuplicatesView({
  pairs,
  notes,
}: {
  readonly pairs: readonly DuplicatePair[];
  readonly notes: readonly DuplicateNote[];
}): React.ReactElement {
  const [mergingId, setMergingId] = useState<string | null>(null);
  const [merged, setMerged] = useState<readonly string[]>([]);

  async function merge(pair: DuplicatePair, platform: GamePlatform): Promise<void> {
    setMergingId(pair.loserId);

    // `finally`, not a bare await. A Server Action that REJECTS rather than
    // returning a failure result skips everything after the await, and the
    // pending id then never clears — every Merge button on the page stays
    // disabled with no error on screen and no way back except a reload. Seen
    // exactly once, when the merge transaction hit a unique-index violation.
    try {
      const result = await mergeDuplicateAction(pair.winnerId, pair.loserId, platform);
      if (result.ok) {
        setMerged((current) => [...current, pair.loserId]);
        toast.success(`Merged into "${pair.winner.title}"`);
        return;
      }
      toast.error(result.error);
    } catch {
      toast.error('That merge could not be completed. Nothing was changed.');
    } finally {
      setMergingId(null);
    }
  }

  const remaining = pairs.filter((pair) => !merged.includes(pair.loserId));

  return (
    <div className="space-y-8">
      <PageHeader
        title="Duplicates"
        meta={
          <span>
            {remaining.length === 0
              ? 'Nothing to merge'
              : `${remaining.length} pair${remaining.length === 1 ? '' : 's'} to review`}
          </span>
        }
      />

      {remaining.length === 0 && notes.length === 0 ? (
        <p className="text-muted-foreground py-16 text-center text-sm">
          No duplicates found. Every game in your library has a title of its own.
        </p>
      ) : null}

      {remaining.map((pair) => (
        <PairCard
          key={pair.loserId}
          pair={pair}
          pending={mergingId === pair.loserId}
          disabled={mergingId !== null}
          onMerge={(platform) => merge(pair, platform)}
        />
      ))}

      {notes.length > 0 ? (
        <Section
          title="Needs your decision"
          description="These look like duplicates, but the data doesn't say which copy to keep."
        >
          <ul className="space-y-3">
            {notes.map((note) => (
              <li key={note.titles.join('|')} className="bg-card rounded-md border p-4 text-sm">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
                  <div className="min-w-0">
                    <p className="text-muted-foreground">{note.reason}</p>
                    <ul className="mt-2 space-y-0.5">
                      {note.titles.map((title) => (
                        <li key={title} className="truncate font-medium">
                          {title}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

function PairCard({
  pair,
  pending,
  disabled,
  onMerge,
}: {
  readonly pair: DuplicatePair;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly onMerge: (platform: GamePlatform) => void;
}): React.ReactElement {
  // Defaults to the first entry, which the server orders winner-first. For a
  // cross-platform pair that is the synced copy's platform; the owner can pick
  // the other, which is the case they actually hit (a PS4 game played on PS5).
  const [platform, setPlatform] = useState<GamePlatform>(pair.platforms[0]!);

  return (
    <div className="bg-card space-y-4 rounded-md border p-5">
      <p className="text-muted-foreground text-sm">{pair.reason}</p>

      <div className="grid items-stretch gap-4 md:grid-cols-[1fr_auto_1fr]">
        <SideCard side={pair.winner} role="keep" />
        <div className="text-muted-foreground flex items-center justify-center">
          <ArrowRight className="size-5 rotate-90 md:rotate-180" aria-hidden />
          <span className="sr-only">is merged into</span>
        </div>
        <SideCard side={pair.loser} role="remove" />
      </div>

      <p className="text-sm">{pair.summary}</p>

      {/* Stated up front, because it is the difference between this merge
          tidying the library and this merge quietly costing a game from the
          count the owner actually keeps. */}
      {pair.createsMember === null ? null : (
        <p className="text-sm">
          Adds <span className="font-medium">{pair.createsMember}</span> to the collection, so it still counts as its
          own game.
        </p>
      )}

      {pair.platforms.length > 1 ? (
        <fieldset className="flex flex-wrap items-center gap-2">
          {/* Not a rule. The owner owns a PS4 copy and played it on PS5, so
              "keep the synced row's platform" would be wrong here — and
              "keep the other one" would be wrong for a genuine cross-gen
              purchase. It is a decision, once per pair. */}
          <legend className="text-muted-foreground mb-1 text-sm">Platform for the surviving row</legend>
          {pair.platforms.map((option) => (
            <Button
              key={option}
              type="button"
              size="sm"
              variant={option === platform ? 'default' : 'outline'}
              aria-pressed={option === platform}
              onClick={() => setPlatform(option)}
              disabled={disabled}
            >
              {PLATFORM_LABELS[option]}
            </Button>
          ))}
        </fieldset>
      ) : null}

      <div className="flex items-center justify-end gap-3 border-t pt-4">
        <p className="text-muted-foreground mr-auto text-xs">
          &ldquo;{pair.loser.title}&rdquo; is deleted. This can&apos;t be undone.
        </p>
        <Button onClick={() => onMerge(platform)} disabled={disabled}>
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Check className="size-4" aria-hidden />}
          Merge
        </Button>
      </div>
    </div>
  );
}

function SideCard({
  side,
  role,
}: {
  readonly side: DuplicateSide;
  readonly role: 'keep' | 'remove';
}): React.ReactElement {
  const keeping = role === 'keep';

  return (
    <div
      className={cn(
        'rounded-md border p-4',
        keeping ? 'border-foreground/30' : 'border-destructive/40 bg-destructive/5',
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className={cn('text-xs font-semibold uppercase', keeping ? '' : 'text-destructive')}>
          {keeping ? 'Kept' : 'Deleted'}
        </span>
        <span className="text-muted-foreground text-xs">
          {PLATFORM_LABELS[side.platform]}
          {side.synced ? ' · linked' : ''}
        </span>
      </div>

      <p className="font-medium" title={side.title}>
        {side.title}
      </p>

      {side.facts.length === 0 ? (
        <p className="text-muted-foreground mt-2 text-sm">Nothing recorded.</p>
      ) : (
        <dl className="mt-3 space-y-1 text-sm">
          {side.facts.map((fact) => (
            <div key={fact.label} className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
