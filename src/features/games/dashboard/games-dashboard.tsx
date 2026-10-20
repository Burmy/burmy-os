import { Section } from '@/components/ui/section';
import { StatCard } from '@/components/ui/stat-card';
import { StatCardGrid } from '@/components/ui/stat-card-grid';
import { countableGames } from '@/server/games/collections';
import { formatHours, hours } from '@/server/games/hours';
import { formatPriceCents } from '@/server/games/money';
import type { GameDlcRow } from '@/server/games/dlc';
import type { PlayYearRow } from '@/server/games/play-years';
import {
  type GameStatRow,
  buildDistribution,
  buildFinancialSummary,
  buildGenreDistribution,
  buildLeaderboard,
  buildLibrarySummary,
  buildTrophyTotals,
  buildYearlyBreakdown,
  findCallouts,
} from '@/server/games/stats';
import { type GamePlatform, PLATFORM_LABELS } from '@/server/games/taxonomy';
import { DistributionChart } from './charts/distribution-chart';
import { GamesPerYearChart } from './charts/games-per-year-chart';
import { HoursPerYearChart } from './charts/hours-per-year-chart';
import { RatingDistributionChart } from './charts/rating-distribution-chart';
import { TrophiesPerYearChart } from './charts/trophies-per-year-chart';
import { TopGames } from './top-games';
import { YearlyBreakdownTable } from './yearly-breakdown-table';

/**
 * Sections inside a dashboard sit 20px apart — the same distance as the gap
 * BETWEEN cards in a `StatCardGrid`, so the whole page runs on one spacing
 * value instead of switching at every section boundary.
 *
 * The page-level rhythm ABOVE this (title -> filter row -> content) stays 32px.
 * That belongs to the shared page contract (`PageHeader`/`FilterBar`), not to
 * either dashboard, and separating a page's chrome from its content is a
 * different job from separating two blocks of that content.
 */
const SECTION_STACK = 'space-y-5';

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
  dlc,
  currentYear,
}: {
  readonly rows: readonly GameStatRow[];
  readonly playYears: readonly PlayYearRow[];
  /** Every DLC row of the owner's; the builders add each one onto its game. See `dlc.ts`. */
  readonly dlc: readonly GameDlcRow[];
  readonly currentYear: number;
}): React.ReactElement {
  const summary = buildLibrarySummary(rows, dlc);
  const trophies = buildTrophyTotals(rows, dlc);
  const financial = buildFinancialSummary(rows, dlc);
  const yearly = buildYearlyBreakdown(rows, playYears, dlc);
  const callouts = findCallouts(rows, dlc, yearly.rows);
  const thisYear = yearly.rows.find((row) => row.year === currentYear);

  // Platform and genre count GAMES, so they exclude collection wrappers —
  // otherwise "The Nathan Drake Collection" contributes a fourth PS4 entry
  // beside its own three titles, and its genre is counted twice. See
  // `countableGames`.
  const games = countableGames(rows);
  const platforms = buildDistribution(
    games,
    (row) => row.platform,
    (key) => PLATFORM_LABELS[key as GamePlatform],
  );
  const genres = buildGenreDistribution(games);

  // OWNERSHIP is the exception, and follows the money rather than the count:
  // physical-vs-digital is a fact about a PURCHASE, and you own one disc
  // containing three games. The titles inside a collection carry no
  // ownership at all (it lives on the collection, like `priceCents`), so
  // passing the full set is both correct and self-limiting — a child
  // contributes nothing because `buildDistribution` skips null keys.
  const ownership = buildDistribution(
    rows,
    (row) => row.ownership,
    (key) => (key === 'physical' ? 'Physical' : 'Digital'),
  );

  // Quality (rating, Metacritic) qualifies the library as a whole, so both
  // ride on the "Games" card rather than each standing alone.
  const qualityHintParts: string[] = [];
  if (summary.averageRating !== null)
    qualityHintParts.push(`${summary.averageRating.toFixed(1)}★ avg rating`);
  if (summary.averageMetacritic !== null)
    qualityHintParts.push(`${summary.averageMetacritic.toFixed(0)} avg Metacritic`);
  const qualityHint = qualityHintParts.length === 0 ? undefined : qualityHintParts.join(' · ');

  // Average playtime qualifies total hours played, so it rides on that card.
  const avgPlaytimeHint =
    summary.averageHoursTenthsPerGame === null
      ? undefined
      : `${formatHours(hours(Math.round(summary.averageHoursTenthsPerGame)))} avg per game`;

  const avgPriceHint =
    financial.averagePriceCents === null
      ? undefined
      : `${formatPriceCents(financial.averagePriceCents)} avg per game`;

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
        <StatCard
          label="Games"
          value={String(summary.totalGames)}
          {...(qualityHint === undefined ? {} : { hint: qualityHint })}
        />
        <StatCard
          label="Hours played"
          value={formatHours(hours(summary.totalHoursTenths))}
          {...(avgPlaytimeHint === undefined ? {} : { hint: avgPlaytimeHint })}
        />
        <StatCard
          label="Platinums"
          value={String(summary.platinumCount)}
          hint={`of ${summary.totalGames} games`}
        />
        {/* From the hand-entered earned/total counts on each game — the same
            numbers the trophies-per-year chart and "Most trophies" read. A
            game with no counts recorded contributes nothing, not zero. */}
        <StatCard
          label="Trophies earned"
          value={trophies.earned.toLocaleString('en-US')}
          hint={trophyHint(trophies)}
        />
        <StatCard
          label="Total spend"
          value={formatPriceCents(financial.totalSpendCents)}
          {...(avgPriceHint === undefined ? {} : { hint: avgPriceHint })}
        />
        <StatCard
          label="Cost per hour"
          value={
            financial.costPerHourCents === null
              ? '—'
              : `${formatPriceCents(financial.costPerHourCents)}/hr`
          }
        />
        {/* Two more so the four-wide grid fills both rows (owner, 2026-10-19:
            "I don't like random white spaces"). Both read figures the page
            already computes — the year table and the trophy totals. */}
        <StatCard
          label="This year"
          value={thisYear === undefined ? '—' : formatHours(hours(thisYear.hoursTenths))}
          hint={
            thisYear === undefined
              ? `Nothing played in ${currentYear} yet`
              : `${thisYear.startedCount} started · ${thisYear.achievements.toLocaleString('en-US')} trophies`
          }
        />
        <StatCard
          label="Completion"
          value={
            trophies.total === null || trophies.total === 0
              ? '—'
              : `${((trophies.earned / trophies.total) * 100).toFixed(1)}%`
          }
          hint={
            trophies.total === null || trophies.total === 0
              ? 'No trophy totals recorded'
              : `of every trophy on the ${trophies.gamesWithTrophies} games that track one`
          }
        />
      </StatCardGrid>

      <Section
        title="Year by year"
        description="Every number here is computed from your library, not stored."
      >
        <YearlyBreakdownTable
          rows={yearly.rows}
          unattributedTenths={yearly.unattributedTenths}
          currentYear={currentYear}
        />
      </Section>

      <Section title="Trends">
        <div className="grid gap-5 lg:grid-cols-3">
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
        <div className="grid gap-5 lg:grid-cols-2">
          <ChartBlock label="Platforms">
            <DistributionChart slices={platforms} emptyMessage="No platforms recorded yet." />
          </ChartBlock>
          <ChartBlock label="Physical vs digital">
            <DistributionChart slices={ownership} emptyMessage="No ownership recorded yet." />
          </ChartBlock>
          <ChartBlock label="Genres">
            <DistributionChart
              slices={genres}
              emptyMessage="No genres yet — add cover art to fill these in."
            />
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
      <div className="grid gap-5 lg:grid-cols-2">
        <TopGames
          title="Most played"
          hint="By total hours"
          metric="hours"
          entries={buildLeaderboard(rows, dlc, 'hours', 3)}
        />
        <TopGames
          title="Highest rated"
          hint="Your own rating"
          metric="rating"
          entries={buildLeaderboard(rows, dlc, 'rating', 3)}
        />
        <TopGames
          title="Most trophies"
          hint="Achievements earned"
          metric="trophies"
          entries={buildLeaderboard(rows, dlc, 'trophies', 3)}
        />
        <TopGames
          title="Best value"
          hint="Lowest cost per hour played"
          metric="costPerHour"
          entries={buildLeaderboard(rows, dlc, 'costPerHour', 3)}
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
          {...(callouts.bestYear === null
            ? {}
            : { hint: formatHours(hours(callouts.bestYear.hoursTenths)) })}
        />
        <StatCard
          label="Most-played genre"
          value={callouts.topGenre?.name ?? '—'}
          {...(callouts.topGenre === null
            ? {}
            : { hint: formatHours(hours(callouts.topGenre.hoursTenths)) })}
        />
        <StatCard
          label="Priciest game"
          value={callouts.priciestGame?.title ?? '—'}
          {...(callouts.priciestGame === null
            ? {}
            : { hint: formatPriceCents(callouts.priciestGame.priceCents) })}
        />
      </StatCardGrid>
    </div>
  );
}

function trophyHint(trophies: ReturnType<typeof buildTrophyTotals>): string {
  const games = `${trophies.gamesWithTrophies} game${trophies.gamesWithTrophies === 1 ? '' : 's'}`;
  return trophies.total === null
    ? `across ${games}`
    : `of ${trophies.total.toLocaleString('en-US')} · ${games}`;
}

/**
 * A small, unbordered label over one chart inside a `Section` that groups
 * several of them (Trends, Breakdown). Deliberately not another nested
 * `Section` — a bordered box inside a bordered box, four times over inside
 * "Breakdown" alone, is the "too many boxes" complaint this redesign exists
 * to fix. One outer `Section` per group, plain labels for what's inside it.
 */
function ChartBlock({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <div>
      <h3 className="text-muted-foreground mb-2 text-xs font-medium">{label}</h3>
      {children}
    </div>
  );
}
