import Image from 'next/image';
import Link from 'next/link';

import { Section } from '@/components/ui/section';
import { StatCard } from '@/components/ui/stat-card';
import { StatCardGrid } from '@/components/ui/stat-card-grid';
import { formatRuntime } from '@/server/anime/runtime';
import {
  type AnimeStatRow,
  type LeaderboardEntry,
  buildAiringEras,
  buildCompletionRates,
  buildFormatDistribution,
  buildGenreDistribution,
  buildLeaderboard,
  buildLibrarySummary,
  buildSourceDistribution,
  buildStudioDistribution,
} from '@/server/anime/stats';
import { AiringEraChart } from './charts/airing-era-chart';
import { DistributionChart } from './charts/distribution-chart';

/** How many shows the "Longest sits" list names. Enough to see a shape, short enough to read. */
const LEADERBOARD_LIMIT = 5;

/**
 * Sections sit 20px apart — the same distance as the gap BETWEEN cards in a
 * `StatCardGrid`, so the page runs on one spacing value rather than switching
 * at every section boundary. Copied from the Games dashboard's own constant,
 * which exists for exactly this reason.
 */
const SECTION_STACK = 'space-y-5';

/**
 * The Anime dashboard.
 *
 * EVERY FIGURE IS COMPUTED HERE FROM `anime` ROWS, at read time. Nothing is
 * stored, which is the invariant Finance states as "never store a total" and
 * which holds for the same reason: an aggregate and the rows it came from can
 * drift, and nothing in this app would notice.
 *
 * A SERVER COMPONENT that hands only the finished shapes to two client charts.
 * The aggregation is pure and framework-free (`server/anime/stats.ts`), so it
 * runs where the data already is rather than shipping the library to the
 * browser to be counted there.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ALL-OR-NOTHING BRANCH IS AT THE TOP AND IS THE POINT.
 *
 * An empty library must render a single, honest "nothing yet" rather than a row
 * of `0`s and four empty charts — the exact defect the Finance dashboard
 * shipped, where `ytdMonthsElapsed: 0` produced a row of `$0.00` cards above a
 * grid full of real numbers. `tests/unit/anime-dashboard-view.test.tsx` covers
 * both branches, because a pure-function suite does not tell you the page
 * renders.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The stat-card rows are deliberately BARE — no `Section`, no heading. Each
 * card is already its own bordered box, so wrapping the row in another one
 * double-boxes the same information. Charts and lists keep their `Section`,
 * because they have no bordering of their own. Both conventions are Finance's
 * and Games' already.
 */
export function AnimeDashboard({ rows }: { readonly rows: readonly AnimeStatRow[] }): React.ReactElement {
  if (rows.length === 0) {
    return (
      <div className="bg-card rounded-md p-8 text-sm">
        <p className="font-medium">No stats yet.</p>
        <p className="text-muted-foreground mt-1">
          Sync from AniList in Settings, or add a show by hand — every figure on this page is computed from
          your library, so it stays empty until there is something in it.
        </p>
      </div>
    );
  }

  const summary = buildLibrarySummary(rows);
  const rates = buildCompletionRates(rows);
  const eras = buildAiringEras(rows);
  const studios = buildStudioDistribution(rows);
  const genres = buildGenreDistribution(rows);
  const formats = buildFormatDistribution(rows);
  const sources = buildSourceDistribution(rows);
  const longest = buildLeaderboard(rows, LEADERBOARD_LIMIT);

  // Rewatch volume qualifies the episode total rather than standing alone —
  // the same "a number that only qualifies another rides in that card's hint"
  // rule the Games dashboard settled on.
  const rewatchHint =
    summary.rewatchedCount === 0
      ? undefined
      : `${summary.rewatchEpisodes.toLocaleString()} from rewatching ${summary.rewatchedCount} show${
          summary.rewatchedCount === 1 ? '' : 's'
        }`;

  // The "≈" is never decoration: it says the figure came from an average
  // episode length AniList publishes, not from a measurement. When some shows
  // have no length at all, the hint says how many were left out entirely.
  const timeHint =
    summary.minutesWatched === null
      ? 'No show has a known episode length yet.'
      : summary.unknownDurationCount === 0
        ? 'Estimated from average episode lengths.'
        : `Estimated — ${summary.unknownDurationCount} show${
            summary.unknownDurationCount === 1 ? '' : 's'
          } with no known episode length ${summary.unknownDurationCount === 1 ? 'is' : 'are'} not counted.`;

  const statusHint = `${summary.byStatus.watching} watching · ${summary.byStatus.completed} completed · ${summary.byStatus.dropped} dropped · ${summary.byStatus.planning} planning`;

  return (
    <div className={SECTION_STACK}>
      <StatCardGrid>
        <StatCard label="Shows" value={summary.showCount.toLocaleString()} hint={statusHint} />
        <StatCard
          label="Episodes watched"
          value={summary.episodesWatched.toLocaleString()}
          {...(rewatchHint === undefined ? {} : { hint: rewatchHint })}
        />
        <StatCard
          label="Time watched"
          value={summary.minutesWatched === null ? '—' : `≈${formatRuntime(summary.minutesWatched)}`}
          hint={timeHint}
        />
        <StatCard
          label="Completion rate"
          // `null` renders as "—", never as 0%: nothing started is not the same
          // as nothing finished.
          value={rates.completionRate === null ? '—' : `${Math.round(rates.completionRate)}%`}
          hint={
            rates.completionRate === null
              ? 'Nothing started yet.'
              : `of ${rates.startedCount} started · ${Math.round(rates.dropRate ?? 0)}% dropped`
          }
        />
      </StatCardGrid>

      <Section
        title="What you watch"
        description="Studios and genres, by number of shows. A show counts in every genre it carries, so these do not sum to your library."
      >
        <div className="grid gap-8 xl:grid-cols-2">
          <ChartBlock label="Studios">
            <DistributionChart slices={studios} emptyMessage="No show has a studio recorded yet." />
          </ChartBlock>
          <ChartBlock label="Genres">
            <DistributionChart slices={genres} emptyMessage="No show has genres recorded yet." />
          </ChartBlock>
        </div>
      </Section>

      <Section title="What kind, and where it came from" description="Format, and the material each show was adapted from.">
        <div className="grid gap-8 xl:grid-cols-2">
          <ChartBlock label="Format">
            <DistributionChart slices={formats} emptyMessage="No show has a format recorded yet." />
          </ChartBlock>
          <ChartBlock label="Source material">
            <DistributionChart slices={sources} emptyMessage="No show has a source recorded yet." />
          </ChartBlock>
        </div>
      </Section>

      <Section
        title="Airing era"
        description="By the year each show aired, not the year you watched it — so a rewatch never moves a bar."
      >
        <AiringEraChart rows={eras} />
      </Section>

      <Section title="Longest sits" description="By episodes actually watched, rewatches included.">
        <Leaderboard entries={longest} />
      </Section>
    </div>
  );
}

/** A labelled chart inside a `Section` — the label is a caption, not a second heading, so it stays at `xs`. */
function ChartBlock({ label, children }: { readonly label: string; readonly children: React.ReactNode }): React.ReactElement {
  return (
    <div className="min-w-0">
      <p className="text-muted-foreground mb-2 text-xs font-medium">{label}</p>
      {children}
    </div>
  );
}

function Leaderboard({ entries }: { readonly entries: readonly LeaderboardEntry[] }): React.ReactElement {
  if (entries.length === 0) {
    return <p className="text-muted-foreground py-8 text-center text-sm">Nothing watched yet.</p>;
  }

  return (
    <ul className="divide-y">
      {entries.map((entry, index) => (
        <li key={entry.id}>
          <Link
            href={`/anime/${entry.id}`}
            className="hover:bg-muted/50 -mx-2 flex min-w-0 items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors"
          >
            <span className="text-muted-foreground tabular w-5 shrink-0 text-right text-xs">{index + 1}</span>
            <span className="bg-muted relative h-12 w-8 shrink-0 overflow-hidden rounded-md">
              {entry.coverUrl === null ? (
                <span
                  className="text-muted-foreground/50 flex h-full items-center justify-center text-xs font-semibold"
                  aria-hidden
                >
                  {entry.title.trim().charAt(0).toUpperCase()}
                </span>
              ) : (
                <Image src={entry.coverUrl} alt="" fill sizes="32px" className="object-cover" />
              )}
            </span>
            <span className="min-w-0 flex-1 truncate">{entry.title}</span>
            <span className="text-muted-foreground tabular shrink-0 whitespace-nowrap text-xs">
              {entry.episodes.toLocaleString()} ep{entry.episodes === 1 ? '' : 's'}
              {/* `null` minutes are simply omitted rather than shown as 0 — a
                  show with no known episode length is still ranked, it just has
                  no estimate to print. */}
              {entry.minutes === null ? '' : ` · ≈${formatRuntime(entry.minutes)}`}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
