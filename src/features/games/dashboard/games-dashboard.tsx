import { Section } from '@/components/ui/section';
import { StatCard } from '@/components/ui/stat-card';
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
import { type GamePlatform, PLATFORM_LABELS } from '@/server/games/taxonomy';
import { DistributionChart } from './charts/distribution-chart';
import { GamesPerYearChart } from './charts/games-per-year-chart';
import { HoursPerYearChart } from './charts/hours-per-year-chart';
import { RatingDistributionChart } from './charts/rating-distribution-chart';
import { TrophiesPerYearChart } from './charts/trophies-per-year-chart';
import { TopGames } from './top-games';
import { YearlyBreakdownTable } from './yearly-breakdown-table';

/**
 * Regrouped from an earlier 14-card, 7-chart, one-column layout that read as
 * an unsegmented wall of numbers. Every group here is a `Section` — no bare
 * `<h2>` anywhere on this page — and every card carries a headline number a
 * reader can name at a glance; a number that only qualifies another (average
 * rating, average Metacritic, average playtime, average price, backlog
 * value) rides in that card's `hint` instead of standing alone as a card of
 * its own. Nothing here is deleted: every figure the old layout showed is
 * still present, either as a card or as a hint.
 */
export function GamesDashboard({
  rows,
  playYears,
  currentYear,
}: {
  readonly rows: readonly GameStatRow[];
  readonly playYears: readonly PlayYearRow[];
  readonly currentYear: number;
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
    <div className="space-y-8">
      <Section title="Library">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Games" value={String(summary.totalGames)} {...(qualityHint === undefined ? {} : { hint: qualityHint })} />
          <StatCard
            label="Hours played"
            value={formatHours(hours(summary.totalHoursTenths))}
            {...(avgPlaytimeHint === undefined ? {} : { hint: avgPlaytimeHint })}
          />
          <StatCard label="Platinums" value={String(summary.platinumCount)} hint={`of ${summary.totalGames} games`} />
          <StatCard label="Backlog" value={String(summary.backlogCount)} hint={`${summary.playingCount} in progress`} />
        </div>
      </Section>

      <Section title="Money" description="What the library cost, and what's still sitting unplayed.">
        <div className="grid grid-cols-2 gap-3">
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
        </div>
      </Section>

      <Section title="Year by year" description="Every number here is computed from your library, not stored.">
        <YearlyBreakdownTable rows={yearly.rows} unattributedTenths={yearly.unattributedTenths} currentYear={currentYear} />
      </Section>

      <Section title="Trends">
        <div className="grid gap-6 lg:grid-cols-3">
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
        <div className="grid gap-6 lg:grid-cols-2">
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

      <Section title="Top 3">
        <div className="grid gap-3 lg:grid-cols-2">
          <TopGames
            title="Most played"
            hint="By total hours"
            metric="hours"
            entries={buildLeaderboard(rows, 'hours', 3)}
          />
          <TopGames
            title="Highest rated"
            hint="Your own rating"
            metric="rating"
            entries={buildLeaderboard(rows, 'rating', 3)}
          />
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
      </Section>

      <Section title="Highlights">
        <div className="grid gap-3 sm:grid-cols-2">
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
        </div>
      </Section>
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
