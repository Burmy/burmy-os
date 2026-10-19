'use client';

import Image from 'next/image';
import { ChevronRight, Gamepad2, Trash2, Trophy, X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useEffect, useState, useTransition } from 'react';

import { PlatinumBadge } from '@/components/games/platinum-badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InlineEditField, InlineEditSelect, ROW_CLASS } from '@/components/ui/inline-edit-row';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import type { ActionResult } from '@/features/games/action-result';
import { CollectionField } from '@/features/games/collections/collection-field';
import { CollectionMembersPanel } from '@/features/games/collections/collection-members-panel';
import {
  deleteGameAction,
  type GameFieldKey,
  updateGameCollectionAction,
  updateGameFieldAction,
  updateGamePlayYearsAction,
} from '@/features/games/game-actions';
import type { PlayYearDraft } from '@/features/games/play-years-panel';
import { cn } from '@/lib/utils';
import type { Game } from '@/server/db/games/games';
import { rollUpTrophies } from '@/server/games/collections';
import { gameTotals } from '@/server/games/dlc';
import { formatHours, hours } from '@/server/games/hours';
import { formatReleaseCountdown } from '@/server/games/release-date';
import {
  GAME_OWNERSHIPS,
  type GameStatus,
  OWNERSHIP_LABELS,
  PLATFORM_LABELS,
  PLATFORM_PICKER_OPTIONS,
  STATUS_LABELS,
} from '@/server/games/taxonomy';
import { DlcGroup } from './dlc-group';
import { type GamePanelSeed, isFullGame } from './game-panel-context';
import { type GamePanelData, getGamePanelAction } from './panel-actions';
import { PlayYearsRow } from './play-years-row';
import { RatingRow } from './rating-row';
import { TitleField } from './title-field';

const STATUS_OPTIONS = ['wanted', 'played'] as const satisfies readonly GameStatus[];

/**
 * The game panel — everything about one game, in a 520px column beside the
 * library (full-screen on a phone). Replaced the per-game page: a page meant
 * a navigation, a blank, and a back button for every title the owner wanted
 * to glance at; a panel means click a cover, read, click the next cover.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NON-MODAL, ON PURPOSE, AND WHAT THAT COSTS.
 *
 * Built directly on Radix `Dialog` with `modal={false}` rather than on the
 * shared `Sheet`: both existing Sheet users (the mobile nav, the Finance
 * import) want a modal with an overlay, and a primitive with two modes helps
 * nobody. Non-modal means no overlay, no focus trap and no body scroll lock
 * — the grid behind stays live — and three things Radix would otherwise do
 * for a modal have to be handled here:
 *
 *   - Radix still dismisses a non-modal dialog on any outside pointer-down.
 *     `onInteractOutside` is prevented, so clicking another cover SWAPS the
 *     panel (the card's own click calls `openGame`) rather than closing it
 *     and reopening a frame later.
 *   - Escape is caught by Radix's document-level capture listener before the
 *     field being edited ever sees it. `onEscapeKeyDown` is prevented when
 *     the event targets a text control, so Esc cancels the field (its own
 *     handler still runs) and a second Esc closes the panel. An open Select
 *     or a nested ConfirmDialog is a higher Radix layer and already shields
 *     this one.
 *   - `z-40`, deliberately below `z-50`: the toast stack, the nested
 *     dialogs (Confirm, the collection picker), Radix Select content and the
 *     mobile nav sheet are all `z-50` and must sit above the panel.
 *
 * DATA. The caller hands over the full `Game` it already has (a library
 * card, a wishlist row), so the header and every scalar row render on the
 * very first frame; the collection data — members, options, candidates —
 * comes from `getGamePanelAction` and fills in a moment later. A swap from
 * inside the panel (a member, the parent collection) has only an id, so it
 * shows a skeleton until that fetch lands. After every successful save the
 * panel re-fetches itself: the action's own `revalidatePath` refreshes the
 * page behind, but this component's copy of the game is state, not a prop,
 * and would otherwise go stale. Stale data stays on screen while the
 * re-fetch is in flight — no flicker.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function GamePanel({
  seed,
  onClose,
  onOpen,
}: {
  readonly seed: GamePanelSeed | null;
  readonly onClose: () => void;
  readonly onOpen: (seed: GamePanelSeed) => void;
}): React.ReactElement {
  const [data, setData] = useState<GamePanelData | null>(null);
  const [version, setVersion] = useState(0);
  const [, startLoad] = useTransition();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // `null` = "not decided by the owner yet": open when the game holds members,
  // collapsed when it holds none. Reset whenever a different game opens.
  const [collectionOpen, setCollectionOpen] = useState<boolean | null>(null);

  const seedId = seed?.id ?? null;
  const [seenSeedId, setSeenSeedId] = useState(seedId);
  if (seenSeedId !== seedId) {
    setSeenSeedId(seedId);
    setCollectionOpen(null);
  }

  useEffect(() => {
    if (seedId === null) return;
    let cancelled = false;
    startLoad(async () => {
      const next = await getGamePanelAction(seedId);
      if (cancelled) return;
      if (next === null) {
        toast.error('That game is no longer in your library.');
        onClose();
        return;
      }
      setData(next);
    });
    return () => {
      cancelled = true;
    };
  }, [seedId, version, onClose]);

  // `data` can belong to the PREVIOUS game for a frame after a swap; only
  // trust it when it is about the game currently open.
  const current = data !== null && data.game.id === seedId ? data : null;
  const game: Game | null = current?.game ?? (seed !== null && isFullGame(seed) ? seed : null);

  function refresh(): void {
    setVersion((value) => value + 1);
  }

  async function saveField(field: GameFieldKey, value: string): Promise<ActionResult> {
    if (seedId === null) return { ok: false, error: 'No game is open.' };
    const result = await updateGameFieldAction(seedId, field, value);
    if (result.ok) refresh();
    return result;
  }

  async function savePlayYears(drafts: readonly PlayYearDraft[]): Promise<ActionResult> {
    if (seedId === null) return { ok: false, error: 'No game is open.' };
    const result = await updateGamePlayYearsAction(seedId, drafts);
    if (result.ok) refresh();
    return result;
  }

  async function saveCollection(collectionId: string | null): Promise<ActionResult> {
    if (seedId === null) return { ok: false, error: 'No game is open.' };
    const result = await updateGameCollectionAction(seedId, collectionId);
    if (result.ok) refresh();
    return result;
  }

  async function remove(): Promise<void> {
    if (game === null) return;
    // try/catch/finally, not a bare await: a rejecting action would otherwise
    // skip the line that clears `deleting` and leave the button dead.
    setDeleting(true);
    try {
      const result = await deleteGameAction(game.id);
      if (result.ok) {
        toast.success(`${game.title} removed`);
        onClose();
      } else {
        toast.error(result.error);
      }
    } catch {
      toast.error('The game could not be removed. Try again.');
    } finally {
      setDeleting(false);
    }
  }

  // Known from the seed alone — no fetch needed to decide these.
  const isCollectionMember = game !== null && game.collectionId !== null;
  const parent = current?.collection ?? null;
  const collectionShown = collectionOpen ?? (current !== null && current.members.length > 0);

  // DLC is additive: the rows below show the BASE figure the owner edits,
  // with the total (base + DLC) as a quiet suffix when there is any DLC.
  const totals = game === null || game.dlc.length === 0 ? null : gameTotals(game, game.dlc);
  const hoursHint =
    totals?.hoursTenths == null ? undefined : `${formatHours(hours(totals.hoursTenths))} with DLC`;
  const priceHint =
    totals?.priceCents == null ? undefined : `$${(totals.priceCents / 100).toFixed(2)} with DLC`;

  return (
    <DialogPrimitive.Root
      open={seed !== null}
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          data-slot="game-panel"
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            const target = event.target;
            if (
              target instanceof HTMLElement &&
              target.closest('input, textarea, [role="combobox"], [role="listbox"]') !== null
            ) {
              event.preventDefault();
            }
          }}
          className="fixed inset-0 z-40 flex flex-col bg-background outline-none sm:inset-y-0 sm:left-auto sm:right-0 sm:w-[520px] sm:border-l sm:shadow-lg"
        >
          <DialogPrimitive.Title className="sr-only">
            {game?.title ?? 'Loading game'}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Every field here saves itself as you edit it.
          </DialogPrimitive.Description>

          <header className="flex items-start gap-3 border-b p-4 pr-12">
            <CoverTile game={game} />
            <div className="min-w-0 flex-1">
              {game === null ? (
                <Skeleton className="h-6 w-48" />
              ) : (
                <TitleField game={game} onSaveField={saveField} onChanged={refresh} />
              )}
              {game === null ? null : (
                <MetaLine game={game} memberCount={current?.members.length ?? 0} />
              )}
              {parent === null ? null : (
                <button
                  type="button"
                  // Distinct from the "Part of" picker row below: this one NAVIGATES.
                  // The visible text stays a prefix of the name (WCAG 2.5.3).
                  aria-label={`Part of ${parent.title} — open collection`}
                  onClick={() => onOpen({ id: parent.id })}
                  className="text-muted-foreground hover:text-foreground mt-1 inline-flex max-w-full items-center gap-1 text-sm transition-colors"
                >
                  <span className="truncate">Part of {parent.title}</span>
                  <ChevronRight className="size-3.5 shrink-0" aria-hidden />
                </button>
              )}
            </div>
            <DialogPrimitive.Close asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close"
                className="absolute top-3 right-3 size-8"
              >
                <X className="size-4" />
              </Button>
            </DialogPrimitive.Close>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {game === null ? (
              <PanelSkeleton />
            ) : (
              <div className="space-y-6">
                <Group title="Progress">
                  <InlineEditSelect
                    label="Status"
                    value={game.status}
                    displayValue={STATUS_LABELS[game.status]}
                    options={STATUS_OPTIONS.map((value) => ({
                      value,
                      label: STATUS_LABELS[value],
                    }))}
                    onSave={(value) => saveField('status', value)}
                  />
                  <RatingRow rating={game.rating} onSave={(value) => saveField('rating', value)} />
                  {/* Only while wanted: it is what sorts the game into "Your
                      wishlist" and gives it a countdown. Once the game is
                      played the date is history and the row goes away. */}
                  {game.status === 'wanted' ? (
                    <InlineEditField
                      label="Release date"
                      value={game.releaseDate ?? ''}
                      displayValue={
                        game.releaseDate !== null && game.releasePrecision !== null
                          ? `${game.releaseDate} · ${formatReleaseCountdown(game.releaseDate, game.releasePrecision, new Date())}`
                          : undefined
                      }
                      placeholder="No date — type YYYY-MM-DD"
                      onSave={(value) => saveField('releaseDate', value)}
                    />
                  ) : null}
                  <InlineEditField
                    label="Hours"
                    value={game.hoursTenths === null ? '' : String(game.hoursTenths / 10)}
                    displayValue={
                      game.hoursTenths === null ? undefined : formatHours(hours(game.hoursTenths))
                    }
                    placeholder="Not tracked"
                    disabled={isCollectionMember}
                    disabledHint="From the collection"
                    {...(hoursHint === undefined ? {} : { hint: hoursHint })}
                    onSave={(value) => saveField('hours', value)}
                  />
                  <InlineEditField
                    label="First played"
                    value={game.firstPlayedYear === null ? '' : String(game.firstPlayedYear)}
                    placeholder="Not set"
                    onSave={(value) => saveField('firstPlayedYear', value)}
                  />
                  {/* A play-year split apportions a game's OWN total across
                      years. A title inside a collection has no total of its
                      own — the set's hours are one figure on the collection. */}
                  {isCollectionMember ? null : (
                    <PlayYearsRow
                      key={`${game.id}:${game.playYears.map((row) => `${row.year}=${row.hoursTenths}`).join(',')}`}
                      hoursTenths={game.hoursTenths}
                      playYears={game.playYears}
                      onSave={savePlayYears}
                    />
                  )}
                  {current === null ? (
                    <>
                      <SkeletonRow label="Achievements earned" />
                      <SkeletonRow label="Achievements total" />
                    </>
                  ) : (
                    <AchievementRows data={current} onSaveField={saveField} />
                  )}
                  <div className={cn(ROW_CLASS, 'items-center')}>
                    <span className="text-muted-foreground">Platinum</span>
                    <PlatinumToggle
                      on={game.platinum}
                      onToggle={() => {
                        void saveField('platinum', game.platinum ? '' : 'true').then((result) => {
                          if (!result.ok) toast.error(result.error);
                        });
                      }}
                    />
                  </div>
                </Group>

                {/* A title inside a collection carries no DLC — its figures,
                    and so its DLC, live on the collection row. */}
                {isCollectionMember ? null : (
                  <DlcGroup gameId={game.id} dlc={game.dlc} base={game} onChanged={refresh} />
                )}

                <Group title="Details">
                  <InlineEditSelect
                    label="Platform"
                    value={game.platform}
                    displayValue={PLATFORM_LABELS[game.platform]}
                    options={(game.platform === 'pc'
                      ? [...PLATFORM_PICKER_OPTIONS, 'pc' as const]
                      : PLATFORM_PICKER_OPTIONS
                    ).map((value) => ({ value, label: PLATFORM_LABELS[value] }))}
                    onSave={(value) => saveField('platform', value)}
                  />
                  {/* A title inside a collection has no money of its own — it
                      lives on the collection and covers the whole set. Shown
                      read-only rather than hidden: "—, from the collection" is
                      information, where an absent row reads as a field this
                      app forgot to offer. */}
                  <InlineEditSelect
                    label="Ownership"
                    value={game.ownership ?? ''}
                    displayValue={game.ownership === null ? '' : OWNERSHIP_LABELS[game.ownership]}
                    options={[
                      { value: '', label: 'Not set' },
                      ...GAME_OWNERSHIPS.map((value) => ({
                        value,
                        label: OWNERSHIP_LABELS[value],
                      })),
                    ]}
                    disabled={isCollectionMember}
                    disabledHint="From the collection"
                    onSave={(value) => saveField('ownership', value)}
                  />
                  <InlineEditField
                    label="Price paid"
                    value={game.priceCents === null ? '' : (game.priceCents / 100).toFixed(2)}
                    displayValue={
                      game.priceCents === null
                        ? undefined
                        : `$${(game.priceCents / 100).toFixed(2)}`
                    }
                    disabled={isCollectionMember}
                    disabledHint="From the collection"
                    {...(priceHint === undefined ? {} : { hint: priceHint })}
                    onSave={(value) => saveField('priceDollars', value)}
                  />
                  <InlineEditField
                    label="Genre"
                    value={game.genre ?? ''}
                    onSave={(value) => saveField('genre', value)}
                  />
                  <InlineEditField
                    label="Developer"
                    value={game.developer ?? ''}
                    onSave={(value) => saveField('developer', value)}
                  />
                  <InlineEditField
                    label="Publisher"
                    value={game.publisher ?? ''}
                    onSave={(value) => saveField('publisher', value)}
                  />
                </Group>

                {/* A row that HOLDS games lists them (and can add more); a
                    standalone row can become a collection the same way, so
                    the members panel shows for both. A title INSIDE a set
                    gets the "Part of" picker instead — it cannot hold games
                    of its own (the one-level rule). */}
                {current === null ? (
                  <Group title="Collection">
                    <SkeletonRow label="Part of" />
                  </Group>
                ) : isCollectionMember ? (
                  <Group title="Collection">
                    <CollectionField
                      collection={current.collection}
                      options={current.collectionOptions}
                      onSave={saveCollection}
                    />
                  </Group>
                ) : (
                  // Collapsed behind a button while it holds nothing — most
                  // games never become a set, and an empty explanatory box on
                  // every one of them was noise. Open by default once it has
                  // members, where the list IS the content.
                  <section>
                    <div className="mb-1 flex items-center justify-between">
                      <h3 className="text-muted-foreground text-xs font-medium">Collection</h3>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setCollectionOpen(!collectionShown)}
                      >
                        {collectionShown ? 'Hide collection' : 'Show collection'}
                      </Button>
                    </div>
                    {collectionShown ? (
                      <CollectionMembersPanel
                        collectionId={game.id}
                        collectionTitle={game.title}
                        members={current.members}
                        candidates={current.collectionCandidates}
                        onOpenMember={(id) => onOpen({ id })}
                        onChanged={refresh}
                      />
                    ) : null}
                  </section>
                )}

                {/* One "Notes" on screen: the group heading. The field keeps
                    the word as its accessible name only. */}
                <Group title="Notes">
                  <InlineEditField
                    hideLabel
                    label="Notes"
                    value={game.notes ?? ''}
                    placeholder="No notes yet — click to add some."
                    multiline
                    onSave={(value) => saveField('notes', value)}
                  />
                </Group>
              </div>
            )}
          </div>

          <footer className="flex justify-end border-t p-4">
            <Button
              type="button"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => setConfirmingDelete(true)}
              disabled={deleting || game === null}
            >
              <Trash2 className="size-4" aria-hidden />
              Remove game
            </Button>
          </footer>

          {game === null ? null : (
            <ConfirmDialog
              open={confirmingDelete}
              onOpenChange={setConfirmingDelete}
              title={`Remove "${game.title}"?`}
              description="This deletes the entry and its history from your library. This can't be undone."
              confirmLabel="Remove"
              destructive
              onConfirm={() => void remove()}
            />
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** 64×85 cover with the same letter-tile fallback the library card uses. */
function CoverTile({ game }: { readonly game: Game | null }): React.ReactElement {
  return (
    <div className="bg-muted relative h-[85px] w-16 shrink-0 overflow-hidden rounded-md">
      {game === null ? null : game.coverUrl === null || game.coverUrl === '' ? (
        <div className="flex h-full flex-col items-center justify-center gap-1" aria-hidden>
          <span className="text-muted-foreground/40 text-2xl font-semibold">
            {game.title.trim().charAt(0).toUpperCase()}
          </span>
          <Gamepad2 className="text-muted-foreground/25 size-3.5" />
        </div>
      ) : (
        <Image src={game.coverUrl} alt="" fill sizes="64px" className="object-cover" />
      )}
      {game?.platinum ? <PlatinumBadge className="absolute top-1 right-1" /> : null}
    </div>
  );
}

/**
 * `platform · status · 3 games`, then a quieter line of IGDB facts
 * when the game has any — a critic score and a time-to-beat answer "is this
 * worth starting" at a glance. ESRB is stored too but never shown; it has
 * not earned a line.
 */
function MetaLine({
  game,
  memberCount,
}: {
  readonly game: Game;
  readonly memberCount: number;
}): React.ReactElement {
  const facts: string[] = [];
  if (game.metacritic !== null) facts.push(`Metacritic ${game.metacritic}`);
  if (game.averagePlaytimeHours !== null) facts.push(`~${game.averagePlaytimeHours}h to beat`);

  return (
    <>
      <p className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
        <span>{PLATFORM_LABELS[game.platform]}</span>
        <span aria-hidden>·</span>
        <span>{STATUS_LABELS[game.status]}</span>
        {memberCount === 0 ? null : (
          <>
            <span aria-hidden>·</span>
            <span>
              {memberCount} game{memberCount === 1 ? '' : 's'}
            </span>
          </>
        )}
      </p>
      {facts.length === 0 ? null : (
        <p className="text-muted-foreground mt-0.5 text-xs">{facts.join(' · ')}</p>
      )}
    </>
  );
}

/**
 * ACHIEVEMENTS ARE THE ONE FIELD A COLLECTION MEMBER OWNS. Hours and price
 * are the set's — one purchase, one play time. Trophies belong to each
 * title, so a member edits its own counts here and a collection reports what
 * its members add up to, read-only. `unsplit` means no member carries
 * anything yet, so the collection's own imported lump is still the best
 * figure there is — shown, and labelled as covering the whole set rather
 * than one game. See `rollUpTrophies`.
 */
function AchievementRows({
  data,
  onSaveField,
}: {
  readonly data: GamePanelData;
  readonly onSaveField: (field: GameFieldKey, value: string) => Promise<ActionResult>;
}): React.ReactElement {
  const rollup = data.members.length > 0 ? rollUpTrophies(data.game, data.members) : undefined;
  const summedFromMembers = rollup !== undefined && !rollup.unsplit && rollup.unlocked !== null;
  const unsplitLump = rollup?.unsplit === true;
  const memberSumHint = 'Added up from the games in this collection';
  const unlocked = summedFromMembers ? rollup.unlocked : data.game.achievementsUnlocked;
  const total = summedFromMembers ? rollup.total : data.game.achievementsTotal;

  // "52 with DLC" — the DLC adds on top of whatever figure the row SHOWS: the
  // member roll-up for a collection, the game's own counts otherwise. Computed
  // here, beside that decision, so the two can never disagree (an earlier
  // version added the DLC to the collection's stale stored figure instead).
  const withDlc =
    data.game.dlc.length === 0
      ? null
      : gameTotals(
          {
            hoursTenths: null,
            priceCents: null,
            achievementsUnlocked: unlocked,
            achievementsTotal: total,
          },
          data.game.dlc,
        );
  const earnedHint =
    withDlc?.achievementsUnlocked == null ? undefined : `${withDlc.achievementsUnlocked} with DLC`;
  const totalHint =
    withDlc?.achievementsTotal == null ? undefined : `${withDlc.achievementsTotal} with DLC`;

  return (
    <>
      <InlineEditField
        label="Achievements earned"
        value={unlocked === null ? '' : String(unlocked)}
        placeholder="Not tracked"
        disabled={summedFromMembers}
        {...(summedFromMembers
          ? {
              disabledHint:
                earnedHint === undefined ? memberSumHint : `${memberSumHint} · ${earnedHint}`,
            }
          : earnedHint === undefined
            ? {}
            : { hint: earnedHint })}
        onSave={(value) => onSaveField('achievementsUnlocked', value)}
      />
      <InlineEditField
        label="Achievements total"
        value={total === null ? '' : String(total)}
        placeholder="Not tracked"
        disabled={summedFromMembers}
        {...(summedFromMembers
          ? {
              disabledHint:
                totalHint === undefined ? memberSumHint : `${memberSumHint} · ${totalHint}`,
            }
          : totalHint !== undefined
            ? { hint: totalHint }
            : unsplitLump
              ? { hint: 'Covers the whole set — not yet split per game' }
              : {})}
        onSave={(value) => onSaveField('achievementsTotal', value)}
      />
    </>
  );
}

/**
 * The owner's own platinum claim as a real toggle — the checkbox it replaced
 * was the smallest control in the panel for the one fact worth showing off.
 * `aria-label` keeps the name "Platinum" stable while the visible text says
 * which state it is in; `aria-pressed` carries the state.
 */
function PlatinumToggle({
  on,
  onToggle,
}: {
  readonly on: boolean;
  readonly onToggle: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      aria-label="Platinum"
      aria-pressed={on}
      onClick={onToggle}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm font-medium transition-colors',
        on
          ? 'border-slate-400/50 bg-gradient-to-br from-slate-100 via-slate-300 to-slate-400 text-slate-800 shadow-sm'
          : 'text-muted-foreground hover:text-foreground border-input',
      )}
    >
      <Trophy className="size-3.5" strokeWidth={2.25} aria-hidden />
      {on ? 'Earned' : 'Not earned'}
    </button>
  );
}

function Group({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <section>
      <h3 className="text-muted-foreground mb-1 text-xs font-medium">{title}</h3>
      <div>{children}</div>
    </section>
  );
}

function SkeletonRow({ label }: { readonly label: string }): React.ReactElement {
  return (
    <div className={cn(ROW_CLASS, 'items-center')}>
      <span className="text-muted-foreground">{label}</span>
      <Skeleton className="h-4 w-32" />
    </div>
  );
}

/** The body while a swap from inside the panel is still fetching — only an id is known. */
function PanelSkeleton(): React.ReactElement {
  return (
    <div className="space-y-6" aria-busy>
      {['Progress', 'Details', 'Notes'].map((title) => (
        <Group key={title} title={title}>
          <Skeleton className="my-1.5 h-4 w-56" />
          <Skeleton className="my-1.5 h-4 w-40" />
          <Skeleton className="my-1.5 h-4 w-48" />
        </Group>
      ))}
    </div>
  );
}
