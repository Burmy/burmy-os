import { Section } from '@/components/ui/section';
import { StatCard } from '@/components/ui/stat-card';
import { StatCardGrid } from '@/components/ui/stat-card-grid';
import { formatHours, hours } from '@/server/games/hours';
import { formatPriceCents } from '@/server/games/money';
import type { PlayYearRow } from '@/server/games/play-years';
import {
  type GameStatRow,
  buildDistribution,
  buildFinancialSummary,
  buildGenreDistribution,
  buildLeaderboard,
  buildLibrarySummary,
  buildYearlyBreakdown,
  findCallouts,
} from '@/server/games/stats';
import type { CloseToPlatinumRow, CompletionSummary, EarnedTrophyRow } from '@/server/db/games/trophies';
import { type GamePlatform, PLATFORM_LABELS } from '@/server/games/taxonomy';
import { CloseToPlatinumList, RarestEarnedList, RecentlyEarnedList } from './trophy-sections';
import { DistributionChart } from './charts/distribution-chart';
import { GamesPerYearChart } from './charts/games-per-year-chart';
import { HoursPerYearChart } from './charts/hours-per-year-chart';
import { RatingDistributionChart } from './charts/rating-distribution-chart';
import { TrophiesPerYearChart } from './charts/trophies-per-year-chart';
import { TopGames } from './top-games';
import { YearlyBreakdownTable } from './yearly-breakdown-table';

/**
 * Sections inside a dashboard sit 16px apart — the same distance as the gap
 * BETWEEN cards in a `StatCardGrid`, so the whole page runs on one spacing
 * value instead of switching to 32px at every section boundary.
 *
 * The page-level rhythm ABOVE this (title -> filter row -> content) stays 32px.
 * That belongs to the shared page contract (`PageHeader`/`FilterBar`), not to
 * either dashboard, and separating a page's chrome from its content is a
 * different job from separating two blocks of that content.
 */
const SECTION_STACK = 'space-y-4';

/**
 * Regrouped from an earlier 14-card, 7-chart, one-column layout that read as
 * an unsegmented wall of numbers. Every card carries a headline number a
 * reader can name at a glance; a number that only qualifies another (average
 * rating, average Metacritic, average playtime, average price, backlog
 * value) rides in that card's `hint` instead of standing alone as a card of
 * its own. Nothing here is deleted: every figure the old layout showed is
 * still present, either as a card or as a hint.
 *
 * Every group of small, individually-bordered cards is deliberately BARE —
 * no `Section`, no heading: the top stat-card row
 * (games/hours/platinums/backlog/spend/cost-per-hour), Top 3 (four
 * `TopGames` cards), and Highlights (two `StatCard`s). Wrapping any of
 * these in an outer `Section` box double-boxes the same information, since
 * each card is already its own bordered box — matching Finance's own
 * convention exactly (`finance-dashboard.tsx`'s Income/Expenses/... row and
 * its `InsightsSection` mini-cards are both bare too). Year by year, Trends,
 * and Breakdown keep their `Section` wrapper: a table and `ChartBlock`-
 * labelled charts have no bordering of their own, so one outer box is the
 * right amount, not a double one — again mirroring Finance, where charts get
 * boxed and only stat-card rows don't.
 */
export function GamesDashboard({
  rows,
  playYears,
  currentYear,
  completion,
  closeToPlatinum,
  recentlyEarned,
  rarestEarned,
  now,
}: {
  readonly rows: readonly GameStatRow[];
  readonly playYears: readonly PlayYearRow[];
  readonly currentYear: number;
  /** All four aggregated in SQL by `server/db/games/trophies.ts` — nothing is counted here. */
  readonly completion: CompletionSummary;
  readonly closeToPlatinum: readonly CloseToPlatinumRow[];
  readonly recentlyEarned: readonly EarnedTrophyRow[];
  readonly rarestEarned: readonly EarnedTrophyRow[];
  /** Read once by the page, like `currentYear`, so "3d ago" stays deterministic and testable. */
  readonly now: Date;
}): React.ReactElement {
  const summary = buildLibrarySummary(rows);
  const financial = buildFinancialSummary(rows);
  const yearly = buildYearlyBreakdown(rows, playYears);
  const callouts = findCallouts(rows, yearly.rows);

  const platforms = buildDistribution(rows, (row) => row.platform, (key) => PLATFORM_LABELS[key as GamePlatform]);
  const ownership = buildDistribution(rows, (row) => row.ownership, (key) => (key === 'physical' ? 'Physical' : 'Digital'));
  const genres = buildGenreDistribution(rows);

  // Quality (rating, Metacritic) qualifies the library as a whole, so both
  // ride on the "Games" card rather than each standing alone.
  const qualityHintParts: string[] = [];
  if (summary.averageRating !== null) qualityHintParts.push(`${summary.averageRating.toFixed(1)}★ avg rating`);
  if (summary.averageMetacritic !== null) qualityHintParts.push(`${summary.averageMetacritic.toFixed(0)} avg Metacritic`);
  const qualityHint = qualityHintParts.length === 0 ? undefined : qualityHintParts.join(' · ');

  // Average playtime qualifies total hours played, so it rides on that card.
  const avgPlaytimeHint =
    summary.averageHoursTenthsPerGame === null
      ? undefined
      : `${formatHours(hours(Math.round(summary.averageHoursTenthsPerGame)))} avg per game`;

  const avgPriceHint =
    financial.averagePriceCents === null ? undefined : `${formatPriceCents(financial.averagePriceCents)} avg per game`;

  return (
    <div className={SECTION_STACK}>
      {/* Bare stat-card row, no Section/heading wrapper — matches Finance's
          own top-row convention exactly (`finance-dashboard.tsx`'s 6-card
          Income/Expenses/Net/... row has no enclosing box or heading
          either, and Finance's `InsightsSection` mini-cards are the same:
          bare `StatCard`s ARE the section, wrapping them in a second bordered
          box under a heading just double-boxes the same information). Library
          and Money used to be two separate boxed/headed groups; merged into
          one 6-card row for the same reason Finance's row is one row, not
          two. */}
      {/* Seven cards across TWO rows (4 + 3), never one.
          At six the seventh wrapped onto a line alone, which reads as a
          mistake. But seven in one row does not fit either: at a typical
          1500px window that leaves ~116px of content per card, and
          "$2,460.67" at the stat type size clipped to "$2460…". `StatCard`
          truncates by design (long values must not widen the grid), so the
          failure was silent — a headline number quietly becoming unreadable.
          Two rows of four give every card room for its value. */}
      <StatCardGrid>
        <StatCard label="Games" value={String(summary.totalGames)} {...(qualityHint === undefined ? {} : { hint: qualityHint })} />
        <StatCard
          label="Hours played"
          value={formatHours(hours(summary.totalHoursTenths))}
          {...(avgPlaytimeHint === undefined ? {} : { hint: avgPlaytimeHint })}
        />
        <StatCard label="Platinums" value={String(summary.platinumCount)} hint={`of ${summary.totalGames} games`} />
        {/* Trophy-grained, and it says so: every trophy counts equally, across
            BOTH PlayStation and Steam. The hint is game-grained instead —
            "how many games are finished" is a different question from "what
            fraction of all trophies do I hold," and conflating them is how a
            completion figure starts misleading. */}
        <StatCard
          label="Completion"
          value={completion.percent === null ? '—' : `${completion.percent}%`}
          hint={
            completion.trackedGames === 0
              ? 'No trophies synced yet'
              : `${completion.completeGames} complete · ${completion.trackedGames} tracked`
          }
        />
        <StatCard label="Backlog" value={String(summary.backlogCount)} hint={`${summary.playingCount} in progress`} />
        <StatCard
          label="Total spend"
          value={formatPriceCents(financial.totalSpendCents)}
          {...(avgPriceHint === undefined ? {} : { hint: avgPriceHint })}
        />
        <StatCard
          label="Cost per hour"
          value={financial.costPerHourCents === null ? '—' : `${formatPriceCents(financial.costPerHourCents)}/hr`}
          hint={`${formatPriceCents(financial.backlogValueCents)} sitting in backlog`}
        />
      </StatCardGrid>

      {/* Above `Year by year` deliberately: the hunt is current, the
          year-by-year table is history, and history reads better underneath.
          Rendered only when there is something to show — three empty-state
          paragraphs side by side is more chrome than absent data deserves. */}
      {closeToPlatinum.length > 0 || recentlyEarned.length > 0 || rarestEarned.length > 0 ? (
        <Section title="Trophies">
          <div className="grid gap-8 lg:grid-cols-3">
            <CloseToPlatinumList rows={closeToPlatinum} />
            <RecentlyEarnedList rows={recentlyEarned} now={now} />
            <RarestEarnedList rows={rarestEarned} />
          </div>
        </Section>
      ) : null}

      <Section title="Year by year" description="Every number here is computed from your library, not stored.">
        <YearlyBreakdownTable rows={yearly.rows} unattributedTenths={yearly.unattributedTenths} currentYear={currentYear} />
      </Section>

      <Section title="Trends">
        <div className="grid gap-4 lg:grid-cols-3">
          <ChartBlock label="Games per year">
            <GamesPerYearChart rows={yearly.rows} />
          </ChartBlock>
          <ChartBlock label="Hours per year">
            <HoursPerYearChart rows={yearly.rows} />
          </ChartBlock>
          <ChartBlock label="Trophies per year">
            <TrophiesPerYearChart rows={yearly.rows} />
          </ChartBlock>
        </div>
      </Section>

      <Section title="Breakdown">
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartBlock label="Platforms">
            <DistributionChart slices={platforms} emptyMessage="No platforms recorded yet." />
          </ChartBlock>
          <ChartBlock label="Physical vs digital">
            <DistributionChart slices={ownership} emptyMessage="No ownership recorded yet." />
          </ChartBlock>
          <ChartBlock label="Genres">
            <DistributionChart slices={genres} emptyMessage="No genres yet — add cover art to fill these in." />
          </ChartBlock>
          <ChartBlock label="Ratings">
            <RatingDistributionChart rows={rows} />
          </ChartBlock>
        </div>
      </Section>

      {/* Bare, no Section/heading — same reasoning as the top stat-card row
          above. `TopGames` is itself a bordered card (`bg-card rounded-md
          border p-4`), so wrapping four of them in a second outer Section
          box was the same "double box" problem the top row already fixed,
          just with a richer card instead of a plain StatCard. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <TopGames title="Most played" hint="By total hours" metric="hours" entries={buildLeaderboard(rows, 'hours', 3)} />
        <TopGames title="Highest rated" hint="Your own rating" metric="rating" entries={buildLeaderboard(rows, 'rating', 3)} />
        <TopGames
          title="Most trophies"
          hint="Achievements earned"
          metric="trophies"
          entries={buildLeaderboard(rows, 'trophies', 3)}
        />
        <TopGames
          title="Best value"
          hint="Lowest cost per hour played"
          metric="costPerHour"
          entries={buildLeaderboard(rows, 'costPerHour', 3)}
        />
      </div>

      {/* These two are `StatCard`s, so they go in the shared grid like every
          other one. At `sm:grid-cols-2` they rendered 548px wide against every
          other card's 266px — the same component at more than double the size,
          on the same page. Two cards in a four-column grid leaves two cells
          empty, which is the correct trade: a card's size should come from the
          app's grid, not from how many happen to sit beside it. */}
      <StatCardGrid>
        <StatCard
          label="Most-played developer"
          value={callouts.topDeveloper?.name ?? '—'}
          {...(callouts.topDeveloper === null
            ? {}
            : { hint: formatHours(hours(callouts.topDeveloper.hoursTenths)) })}
        />
        <StatCard
          label="Best year"
          value={callouts.bestYear === null ? '—' : String(callouts.bestYear.year)}
          {...(callouts.bestYear === null ? {} : { hint: formatHours(hours(callouts.bestYear.hoursTenths)) })}
        />
      </StatCardGrid>
    </div>
  );
}

/**
 * A small, unbordered label over one chart inside a `Section` that groups
 * several of them (Trends, Breakdown). Deliberately not another nested
 * `Section` — a bordered box inside a bordered box, four times over inside
 * "Breakdown" alone, is the "too many boxes" complaint this redesign exists
 * to fix. One outer `Section` per group, plain labels for what's inside it.
 */
function ChartBlock({ label, children }: { readonly label: string; readonly children: React.ReactNode }): React.ReactElement {
  return (
    <div>
      <h3 className="text-muted-foreground mb-2 text-xs font-medium">{label}</h3>
      {children}
    </div>
  );
}
