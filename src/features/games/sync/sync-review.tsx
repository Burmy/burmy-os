'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import type { SyncChange, SyncRun } from '@/server/db/games/sync';
import { formatHours, hours } from '@/server/games/hours';
import { commitSyncRunAction, setSyncChangeSelectedAction } from './sync-actions';

/**
 * `new_game` changes at or above this count get a visibly prominent count
 * and warning in the "New games" group header below — a curated ~160-game
 * PlayStation library can have PSN report back several hundred demos and PS
 * Plus claims, and the owner asked for that volume to be impossible to miss
 * BEFORE approving a run, not just documented as a risk. Source-agnostic on
 * purpose: nothing stops a large Steam library from crossing it too, and the
 * warning is equally correct either way.
 */
const NEW_GAME_VOLUME_WARNING_THRESHOLD = 100;

/**
 * The Steam sync review screen — the owner's last word before anything a
 * sync run proposed reaches `games`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SELECTION IS THE SAME OPTIMISTIC-PATCH-THEN-REVERT IDIOM AS FINANCE'S
 * `ImportReviewTable` (`src/features/finance/import/review-table.tsx`): a
 * checkbox flips local state immediately, then awaits the Server Action, and
 * only patches back to the previous value if that action reports failure.
 * There is no `Set`-based bulk-selection model anywhere in this codebase —
 * this does not introduce one either.
 *
 * THE COMMIT BUTTON'S DISABLED STATE IS PLAIN `useState`, NOT `useOptimistic`.
 * This codebase has a documented bug (see CLAUDE.md) where an assertion
 * passed on optimistic state alone while the server write had not actually
 * landed. `committing` here only ever reflects a real awaited response.
 *
 * `reconcile` changes are staged with `selected: false` by `appendSyncChanges`
 * (`src/server/db/games/sync.ts`) and rendered exactly as given — this
 * component never re-derives or overrides that default.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function SyncReview({
  run,
  changes: initialChanges,
}: {
  readonly run: SyncRun;
  readonly changes: readonly SyncChange[];
}): React.ReactElement {
  const router = useRouter();
  const [changes, setChanges] = useState(initialChanges);
  const [pending, startTransition] = useTransition();
  const [committing, setCommitting] = useState(false);

  function patchChange(changeId: string, patch: Partial<SyncChange>): void {
    setChanges((prev) => prev.map((change) => (change.id === changeId ? { ...change, ...patch } : change)));
  }

  function setSelected(changeId: string, selected: boolean): void {
    const previous = changes.find((change) => change.id === changeId)?.selected ?? !selected;
    patchChange(changeId, { selected });
    startTransition(async () => {
      const outcome = await setSyncChangeSelectedAction(changeId, selected);
      if (!outcome.ok) {
        toast.error(outcome.error);
        patchChange(changeId, { selected: previous });
      }
    });
  }

  async function commit(): Promise<void> {
    setCommitting(true);
    const outcome = await commitSyncRunAction(run.id);
    // Deliberately not reset to `false` on success: the button below
    // navigates away immediately, and leaving it disabled (rather than
    // clickable again for a fraction of a second) avoids a double-commit
    // attempt racing the redirect.
    if (!outcome.ok) {
      setCommitting(false);
      toast.error(outcome.error);
      return;
    }
    router.push('/games/library');
  }

  if (changes.length === 0) {
    return (
      <div className="mt-8 max-w-md space-y-3 rounded-md border p-4 text-sm">
        <p className="font-medium">Nothing to review.</p>
        <p className="text-muted-foreground">
          This sync run found no changes — your library already matches Steam.
        </p>
        <Button size="sm" onClick={() => router.push('/games/library')}>
          Back to library
        </Button>
      </div>
    );
  }

  const needsAttention = changes.filter((change) => change.kind === 'reconcile');
  const newGames = changes.filter((change) => change.kind === 'new_game');
  const fieldUpdates = changes.filter((change) => change.kind === 'field_update');
  const links = changes.filter((change) => change.kind === 'link');

  const selectedCount = changes.filter((change) => change.selected).length;
  const disableApply = pending || committing || selectedCount === 0;

  return (
    <div className="space-y-8">
      {needsAttention.length > 0 ? (
        <ChangeGroup title="Needs attention" description="These need your review — nothing here applies automatically.">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">Select</TableHead>
                <TableHead>Game</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {needsAttention.map((change) => (
                <TableRow key={change.id}>
                  <SelectCell change={change} disabled={pending} onChange={setSelected} />
                  <TableCell className="font-medium">{change.title}</TableCell>
                  <TableCell className="text-muted-foreground">{reconcileDescription(change.payload)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ChangeGroup>
      ) : null}

      {newGames.length > 0 ? (
        <ChangeGroup
          title={`New games (${newGames.length})`}
          description={
            newGames.length > NEW_GAME_VOLUME_WARNING_THRESHOLD
              ? `${newGames.length} new games found — review carefully before applying. A full library mirror can include demos and claimed-but-unplayed titles.`
              : 'Owned, not yet in your library.'
          }
          warn={newGames.length > NEW_GAME_VOLUME_WARNING_THRESHOLD}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">Select</TableHead>
                <TableHead>Title</TableHead>
                <TableHead className="text-right">Hours</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {newGames.map((change) => {
                const payload = parseNewGamePayload(change.payload);
                return (
                  <TableRow key={change.id}>
                    <SelectCell change={change} disabled={pending} onChange={setSelected} />
                    <TableCell className="font-medium">{change.title}</TableCell>
                    <TableCell className="tabular text-right">{formatFieldValue('hoursTenths', payload.hoursTenths)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </ChangeGroup>
      ) : null}

      {fieldUpdates.length > 0 ? (
        <ChangeGroup title="Field updates" description="Steam's numbers differ from what's stored.">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">Select</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Field</TableHead>
                <TableHead>Change</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {fieldUpdates.map((change) => {
                const payload = parseFieldUpdatePayload(change.payload);
                return (
                  <TableRow key={change.id}>
                    <SelectCell change={change} disabled={pending} onChange={setSelected} />
                    <TableCell className="font-medium">{change.title}</TableCell>
                    <TableCell className="text-muted-foreground">{FIELD_LABELS[payload.field] ?? payload.field}</TableCell>
                    <TableCell className="tabular">
                      {formatFieldValue(payload.field, payload.from)} → {formatFieldValue(payload.field, payload.to)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </ChangeGroup>
      ) : null}

      {links.length > 0 ? (
        <ChangeGroup title="Links" description="Matched to a Steam app for the first time.">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">Select</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Steam app</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {links.map((change) => {
                const payload = parseLinkPayload(change.payload);
                return (
                  <TableRow key={change.id}>
                    <SelectCell change={change} disabled={pending} onChange={setSelected} />
                    <TableCell className="font-medium">{change.title}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {payload.steamAppid === null ? '—' : `#${payload.steamAppid}`}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </ChangeGroup>
      ) : null}

      <div className="bg-background sticky bottom-0 flex items-center gap-3 border-t py-3">
        <Button onClick={commit} disabled={disableApply}>
          {committing ? 'Applying…' : `Apply ${selectedCount} selected change${selectedCount === 1 ? '' : 's'}`}
        </Button>
      </div>
    </div>
  );
}

function ChangeGroup({
  title,
  description,
  warn = false,
  children,
}: {
  readonly title: string;
  readonly description: string;
  /** Renders the description in the app's standing "needs attention" amber, for a volume the owner should not skim past. */
  readonly warn?: boolean;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        <p className={warn ? 'text-sm font-medium text-amber-600 dark:text-amber-400' : 'text-muted-foreground text-sm'}>
          {description}
        </p>
      </div>
      {children}
    </section>
  );
}

function SelectCell({
  change,
  disabled,
  onChange,
}: {
  readonly change: SyncChange;
  readonly disabled: boolean;
  readonly onChange: (changeId: string, selected: boolean) => void;
}): React.ReactElement {
  return (
    <TableCell>
      <Checkbox
        aria-label={`Include ${change.title}`}
        checked={change.selected}
        disabled={disabled}
        onCheckedChange={(state) => onChange(change.id, state === true)}
      />
    </TableCell>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Payload parsing — display-only, deliberately permissive.
//
// `SyncChange.payload` is `Record<string, unknown>`: real staging shapes,
// but not compile-time checked at this boundary. Unlike `commitSyncRun`'s own
// whitelist (`src/server/db/games/sync.ts`), a malformed value here degrades
// to a placeholder rather than throwing — this is a read-only review screen,
// not the write path, so there is nothing to protect by refusing to render.
// ─────────────────────────────────────────────────────────────────────────────

const FIELD_LABELS: Record<string, string> = {
  hoursTenths: 'Hours',
  achievementsUnlocked: 'Achievements unlocked',
  achievementsTotal: 'Achievements total',
  steamAppid: 'Steam app',
};

function asNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function formatFieldValue(field: string, value: number | null): string {
  if (value === null) return '—';
  if (field === 'hoursTenths') return formatHours(hours(value));
  return String(value);
}

function parseFieldUpdatePayload(payload: Record<string, unknown>): {
  readonly field: string;
  readonly from: number | null;
  readonly to: number | null;
} {
  return {
    field: typeof payload.field === 'string' ? payload.field : 'field',
    from: asNumber(payload.from),
    to: asNumber(payload.to),
  };
}

function parseNewGamePayload(payload: Record<string, unknown>): { readonly hoursTenths: number | null } {
  return { hoursTenths: asNumber(payload.hoursTenths) };
}

function parseLinkPayload(payload: Record<string, unknown>): { readonly steamAppid: number | null } {
  return { steamAppid: asNumber(payload.steamAppid) };
}

function reconcileDescription(payload: Record<string, unknown>): string {
  const newTotal = asNumber(payload.newTotalTenths);
  const split = asNumber(payload.splitTenths);
  if (newTotal === null || split === null) return 'Your year-by-year split no longer matches the new total.';
  return `Your recorded years add up to ${formatFieldValue('hoursTenths', split)}, but the new total is ${formatFieldValue(
    'hoursTenths',
    newTotal,
  )}. Rebalance the split on the game's page.`;
}
