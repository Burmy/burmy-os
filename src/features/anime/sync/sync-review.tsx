'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { STATUS_LABELS, isAnimeStatus } from '@/server/anime/taxonomy';
import type { AnimeSyncChange, AnimeSyncRun } from '@/server/db/anime/sync';
import { commitAnimeSyncRunAction, setAnimeSyncChangeSelectedAction } from './sync-actions';

/**
 * `new_anime` changes at or above this count get a prominent, amber header.
 *
 * A first sync of a real AniList profile legitimately proposes hundreds of
 * shows, and that is the one time the owner should read the list rather than
 * skim it — everything below is about to become their library. The Games
 * screen sets the same threshold for the same reason.
 */
const NEW_SHOW_VOLUME_WARNING_THRESHOLD = 100;

/**
 * The anime sync review screen — the owner's last word before anything an
 * AniList run proposed reaches `anime`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DELIBERATELY A SEPARATE FILE FROM `features/games/sync/sync-review.tsx`.
 *
 * The two look alike and are not the same screen: this one has no cover
 * enrichment phase, no `reconcile` group, an advisory `series_hint` group that
 * Games has no equivalent of, and a `progress` row that must be able to say
 * "this would move you BACKWARDS". CLAUDE.md's rule is explicit that a Games
 * component and an Anime component that resemble each other are two files
 * whose constraints differ, not duplication awaiting a factor-out.
 *
 * SELECTION IS OPTIMISTIC-PATCH-THEN-REVERT, the idiom Finance's
 * `ImportReviewTable` and the Games review screen both use: flip local state,
 * await the Server Action, patch back only on failure.
 *
 * THE COMMIT BUTTON'S DISABLED STATE IS PLAIN `useState`, NOT `useOptimistic`
 * — this codebase has a documented bug where an assertion passed on optimistic
 * state alone while the write had not landed. `committing` only ever reflects
 * a real awaited response.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function AnimeSyncReview({
  run,
  changes: initialChanges,
}: {
  readonly run: AnimeSyncRun;
  readonly changes: readonly AnimeSyncChange[];
}): React.ReactElement {
  const router = useRouter();
  const [changes, setChanges] = useState(initialChanges);
  const [pending, startTransition] = useTransition();
  const [committing, setCommitting] = useState(false);

  function patchChange(changeId: string, patch: Partial<AnimeSyncChange>): void {
    setChanges((prev) => prev.map((change) => (change.id === changeId ? { ...change, ...patch } : change)));
  }

  function setSelected(changeId: string, selected: boolean): void {
    const previous = changes.find((change) => change.id === changeId)?.selected ?? !selected;
    patchChange(changeId, { selected });
    startTransition(async () => {
      const outcome = await setAnimeSyncChangeSelectedAction(changeId, selected);
      if (!outcome.ok) {
        toast.error(outcome.error);
        patchChange(changeId, { selected: previous });
      }
    });
  }

  async function commit(): Promise<void> {
    setCommitting(true);
    // A rejected Server Action skips every line after its `await`, which is how
    // the Games duplicates screen once stranded every button disabled with no
    // error shown. The `catch` is the fix, not decoration.
    let outcome;
    try {
      outcome = await commitAnimeSyncRunAction(run.id);
    } catch {
      setCommitting(false);
      toast.error('Applying the changes failed. Nothing was saved.');
      return;
    }

    // Deliberately not reset on success: the redirect below fires immediately,
    // and leaving the button disabled avoids a double-commit racing it.
    if (!outcome.ok) {
      setCommitting(false);
      toast.error(outcome.error);
      return;
    }

    // `skipped` counts a staged `new_anime` that already existed by commit
    // time — another run created it since. Surfaced, so the owner sees "3
    // already existed" rather than silently getting fewer shows than approved.
    if (outcome.skipped > 0) {
      const total = outcome.applied + outcome.created;
      toast.success(
        `Applied ${total} change${total === 1 ? '' : 's'} — ${outcome.skipped} show${
          outcome.skipped === 1 ? '' : 's'
        } already existed and ${outcome.skipped === 1 ? 'was' : 'were'} skipped.`,
      );
    }
    router.push('/anime/library');
  }

  if (changes.length === 0) {
    return (
      <div className="bg-card mt-8 max-w-md space-y-3 rounded-md p-6 text-sm">
        <p className="font-medium">Nothing to review.</p>
        <p className="text-muted-foreground">
          This sync found no changes — your library already matches AniList.
        </p>
        <Button size="sm" onClick={() => router.push('/anime/library')}>
          Back to library
        </Button>
      </div>
    );
  }

  const newShows = changes.filter((change) => change.kind === 'new_anime');
  const fieldUpdates = changes.filter((change) => change.kind === 'field_update');
  const links = changes.filter((change) => change.kind === 'link');
  const seriesHints = changes.filter((change) => change.kind === 'series_hint');

  const selectedCount = changes.filter((change) => change.selected).length;
  const disableApply = pending || committing || selectedCount === 0;

  return (
    <div className="space-y-8">
      {newShows.length > 0 ? (
        <ChangeGroup
          title={`New shows (${newShows.length})`}
          description={
            newShows.length > NEW_SHOW_VOLUME_WARNING_THRESHOLD
              ? `${newShows.length} shows on AniList have no entry here yet — this is your library being created, so read it before applying.`
              : 'On your AniList list, not yet in your library.'
          }
          warn={newShows.length > NEW_SHOW_VOLUME_WARNING_THRESHOLD}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">Select</TableHead>
                <TableHead className="w-14"></TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Progress</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {newShows.map((change) => {
                const payload = parseNewAnimePayload(change.payload);
                return (
                  <TableRow key={change.id}>
                    <SelectCell change={change} disabled={pending} onChange={setSelected} />
                    <TableCell>
                      <Cover coverUrl={payload.coverUrl} title={change.title} />
                    </TableCell>
                    <TableCell className="font-medium">{change.title}</TableCell>
                    <TableCell className="text-muted-foreground">{formatStatus(payload.status)}</TableCell>
                    <TableCell className="tabular text-right">
                      {formatProgress(payload.progress, payload.episodes)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </ChangeGroup>
      ) : null}

      {fieldUpdates.length > 0 ? (
        <ChangeGroup title="Field updates" description="AniList differs from what's stored.">
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
                      <span className={payload.decrease ? 'font-medium text-amber-600 dark:text-amber-400' : undefined}>
                        {formatFieldValue(payload.field, payload.from)} → {formatFieldValue(payload.field, payload.to)}
                      </span>
                      {/* A progress DECREASE is the one field change that can
                          destroy something real, so it is labelled rather than
                          left to look like any other number moving. Staged, not
                          blocked — see `planLinkedAnimeChanges`. */}
                      {payload.decrease ? (
                        <span className="block text-xs text-amber-600 dark:text-amber-400">
                          Moves your progress backwards.
                        </span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </ChangeGroup>
      ) : null}

      {links.length > 0 ? (
        <ChangeGroup title="Links" description="Matched to an AniList entry for the first time.">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">Select</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>AniList entry</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {links.map((change) => (
                <TableRow key={change.id}>
                  <SelectCell change={change} disabled={pending} onChange={setSelected} />
                  <TableCell className="font-medium">{change.title}</TableCell>
                  <TableCell className="text-muted-foreground tabular">
                    {formatMediaId(change.payload.anilistMediaId)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ChangeGroup>
      ) : null}

      {seriesHints.length > 0 ? (
        <ChangeGroup
          title="Series suggestions"
          description="AniList says these are related. Advisory only — applying nothing, and unselected until you say otherwise."
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">Select</TableHead>
                <TableHead>Show</TableHead>
                <TableHead>Related to</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {seriesHints.map((change) => (
                <TableRow key={change.id}>
                  <SelectCell change={change} disabled={pending} onChange={setSelected} />
                  <TableCell className="font-medium">{change.title}</TableCell>
                  <TableCell className="text-muted-foreground">{formatRelatedTitles(change.payload)}</TableCell>
                </TableRow>
              ))}
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
  /** Renders the description in the app's standing "needs attention" amber. */
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

/**
 * A new show's cover, portrait (2:3) because that is the shape anime art comes
 * in — the same aspect the library grid uses. Falls back to a letter tile when
 * AniList had no image, exactly as the Games screens do.
 */
function Cover({ coverUrl, title }: { readonly coverUrl: string | null; readonly title: string }): React.ReactElement {
  return (
    <div className="bg-muted relative h-14 w-[2.625rem] shrink-0 overflow-hidden rounded-md">
      {coverUrl === null ? (
        <span className="text-muted-foreground flex h-full items-center justify-center text-sm font-semibold" aria-hidden>
          {title.charAt(0).toUpperCase()}
        </span>
      ) : (
        <Image src={coverUrl} alt="" fill sizes="42px" className="object-cover" />
      )}
    </div>
  );
}

function SelectCell({
  change,
  disabled,
  onChange,
}: {
  readonly change: AnimeSyncChange;
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
// `AnimeSyncChange.payload` is `Record<string, unknown>`: real staged shapes,
// but not compile-time checked at this boundary. Unlike `commitAnimeSyncRun`'s
// exhaustive switch (`src/server/db/anime/sync.ts`), a malformed value here
// degrades to a placeholder rather than throwing — this is a read-only review
// screen, not the write path, so refusing to render protects nothing.
// ─────────────────────────────────────────────────────────────────────────────

const FIELD_LABELS: Record<string, string> = {
  status: 'Status',
  progress: 'Progress',
  repeatCount: 'Rewatches',
  episodes: 'Episodes',
  durationMinutes: 'Episode length',
  studio: 'Studio',
  genre: 'Genres',
  coverUrl: 'Cover art',
};

type FieldValue = number | string | boolean | null;

function asFieldValue(value: unknown): FieldValue {
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  return null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function formatStatus(value: unknown): string {
  return isAnimeStatus(value) ? STATUS_LABELS[value] : '—';
}

/** `12 / 24`, or just `12` when the show's length is unknown (an airing season). */
function formatProgress(progress: number | null, episodes: number | null): string {
  if (progress === null) return '—';
  return episodes === null ? String(progress) : `${progress} / ${episodes}`;
}

function formatFieldValue(field: string, value: FieldValue): string {
  if (value === null) return '—';
  if (field === 'status') return formatStatus(value);
  if (field === 'durationMinutes' && typeof value === 'number') return `${value}m`;
  // A cover URL is 100+ characters of CDN path and tells the owner nothing.
  // What they actually need to know is whether art is arriving, which is the
  // only direction this field is ever proposed in (fill-when-missing).
  if (field === 'coverUrl') return typeof value === 'string' ? 'an image' : 'none';
  return String(value);
}

function parseFieldUpdatePayload(payload: Record<string, unknown>): {
  readonly field: string;
  readonly from: FieldValue;
  readonly to: FieldValue;
  readonly decrease: boolean;
} {
  return {
    field: typeof payload.field === 'string' ? payload.field : 'field',
    from: asFieldValue(payload.from),
    to: asFieldValue(payload.to),
    decrease: payload.decrease === true,
  };
}

function parseNewAnimePayload(payload: Record<string, unknown>): {
  readonly status: unknown;
  readonly progress: number | null;
  readonly episodes: number | null;
  readonly coverUrl: string | null;
} {
  return {
    status: payload.status,
    progress: asNumber(payload.progress),
    episodes: asNumber(payload.episodes),
    coverUrl: typeof payload.coverUrl === 'string' ? payload.coverUrl : null,
  };
}

function formatMediaId(value: unknown): string {
  const id = asNumber(value);
  return id === null ? '—' : `#${id}`;
}

function formatRelatedTitles(payload: Record<string, unknown>): string {
  const titles = Array.isArray(payload.relatedTitles)
    ? payload.relatedTitles.filter((title): title is string => typeof title === 'string')
    : [];
  return titles.length > 0 ? titles.join(' · ') : '—';
}
