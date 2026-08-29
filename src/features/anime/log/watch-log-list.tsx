import Image from 'next/image';
import Link from 'next/link';

import { formatHumanDate } from '@/lib/format-date';
import type { WatchLogEntry } from '@/server/db/anime/watch-log';

/**
 * The watch log, rendered.
 *
 * ONE COMPONENT, TWO VIEWS — the Log tab shows every show's entries and the
 * show page shows one show's. The only difference is whether each row names
 * the show it belongs to, which is `showTitles`. Two components would be two
 * places for the date format and the "marked completed" wording to drift.
 *
 * Grouped by DAY. A raw reverse-chronological list of 400 rows is a wall; the
 * shape a person actually reads is "on this day, these episodes" — and binge
 * watching means one day routinely holds a dozen entries.
 */
export function WatchLogList({
  entries,
  showTitles = true,
}: {
  readonly entries: readonly WatchLogEntry[];
  /** The show page already has the title at the top of the page; repeating it on every row is noise. */
  readonly showTitles?: boolean;
}): React.ReactElement {
  const days = groupByDay(entries);

  return (
    <div className="min-w-0 space-y-6">
      {days.map((day) => (
        <section key={day.key}>
          <h3 className="text-muted-foreground mb-2 text-xs font-medium">
            {day.label}
            <span className="ml-2 font-normal">
              {day.entries.length} {day.entries.length === 1 ? 'entry' : 'entries'}
            </span>
          </h3>
          <ul className="bg-card divide-y rounded-md px-4">
            {day.entries.map((entry) => (
              <li key={entry.id} className="min-w-0">
                {showTitles ? (
                  <Link
                    href={`/anime/${entry.animeId}`}
                    // An explicit name. The row's visible text is a title, an
                    // event and a time in three sibling elements, and a
                    // computed accessible name joins child nodes with each one
                    // TRIMMED — "Moved ForwardEpisode 92:00 AM", which reads
                    // as nonsense and cannot be queried for. The visible words
                    // stay a prefix of this string, per WCAG 2.5.3. See
                    // CLAUDE.md; this is the second time it has bitten.
                    aria-label={`${entry.title} — ${describeEvent(entry)}, ${timeOf(entry.watchedAt)}`}
                    className="hover:bg-muted/50 -mx-2 flex min-w-0 items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors"
                  >
                    <Cover entry={entry} />
                    <span className="min-w-0 flex-1 truncate" aria-hidden>
                      {entry.title}
                    </span>
                    <EventText entry={entry} />
                  </Link>
                ) : (
                  <div className="flex min-w-0 items-center gap-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">{describeEvent(entry)}</span>
                    <span className="text-muted-foreground shrink-0 text-xs">{timeOf(entry.watchedAt)}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Cover({ entry }: { readonly entry: WatchLogEntry }): React.ReactElement {
  return (
    <span className="bg-muted relative h-10 w-7 shrink-0 overflow-hidden rounded">
      {entry.coverUrl === null ? (
        <span
          className="text-muted-foreground/50 flex h-full items-center justify-center text-[10px] font-semibold"
          aria-hidden
        >
          {entry.title.trim().charAt(0).toUpperCase()}
        </span>
      ) : (
        <Image src={entry.coverUrl} alt="" fill sizes="28px" className="object-cover" />
      )}
    </span>
  );
}

/** `aria-hidden`: the whole row carries an explicit `aria-label` that already says all of this, properly spaced. */
function EventText({ entry }: { readonly entry: WatchLogEntry }): React.ReactElement {
  return (
    <span className="text-muted-foreground shrink-0 whitespace-nowrap text-xs" aria-hidden>
      {describeEvent(entry)}
      <span className="ml-2">{timeOf(entry.watchedAt)}</span>
    </span>
  );
}

/**
 * What the entry says happened.
 *
 * A `status` entry has no episode number — it is AniList recording "completed"
 * or "dropped" rather than an episode finishing — and printing "Episode null"
 * or silently rendering an empty cell would both be worse than saying so.
 */
function describeEvent(entry: WatchLogEntry): string {
  if (entry.episode !== null) return `Episode ${entry.episode}`;
  return entry.kind === 'status' ? 'Status changed' : 'Watched';
}

function timeOf(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

interface Day {
  readonly key: string;
  readonly label: string;
  readonly entries: WatchLogEntry[];
}

/**
 * Groups already-sorted entries into days, preserving their order.
 *
 * Keyed on the LOCAL date, not the UTC one: an episode finished at 11pm local
 * is part of that evening, and bucketing by UTC would scatter a single night's
 * binge across two headings for anyone west of Greenwich.
 */
function groupByDay(entries: readonly WatchLogEntry[]): Day[] {
  const days: Day[] = [];

  for (const entry of entries) {
    const key = localDayKey(entry.watchedAt);
    const current = days.at(-1);
    if (current?.key === key) current.entries.push(entry);
    else days.push({ key, label: formatHumanDate(key), entries: [entry] });
  }

  return days;
}

function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
