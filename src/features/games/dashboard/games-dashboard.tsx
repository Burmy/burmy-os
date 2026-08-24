import { formatHours, hours } from '@/server/games/hours';
import { formatPriceCents } from '@/server/games/money';
import type { PlayYearRow } from '@/server/games/play-years';
import {
  type GameStatRow,
  buildDistribution,
  buildFinancialSummary,
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
import { YearlyBreakdownTable } from './yearly-breakdown-table';

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
  const callouts = findCallouts(rows);

  const platforms = buildDistribution(rows, (row) => row.platform, (key) => PLATFORM_LABELS[key as GamePlatform]);
  const ownership = buildDistribution(rows, (row) => row.ownership, (key) => (key === 'physical' ? 'Physical' : 'Digital'));
  const genres = buildDistribution(rows, (row) => row.genre, (key) => key);

  return (
    <div className="space-y-8">
      <StatGroup title="Library">
        <StatCard label="Games" value={String(summary.totalGames)} />
        <StatCard label="Hours played" value={formatHours(hours(summary.totalHoursTenths))} />
        <StatCard label="Backlog" value={String(summary.backlogCount)} hint={`${summary.playingCount} in progress`} />
        <StatCard
          label="Completion rate"
          value={summary.completionRatePercent === null ? '—' : `${summary.completionRatePercent.toFixed(0)}%`}
          hint="of games started"
        />
      </StatGroup>

      <StatGroup title="Ratings & achievements">
        <StatCard
          label="Average rating"
          value={summary.averageRating === null ? '—' : `${summary.averageRating.toFixed(1)} / 5`}
        />
        <StatCard
          label="Average Metacritic"
          value={summary.averageMetacritic === null ? '—' : summary.averageMetacritic.toFixed(0)}
        />
        <StatCard label="Platinums" value={String(summary.platinumCount)} hint={`of ${summary.totalGames} games`} />
        <StatCard
          label="Average playtime"
          value={
            summary.averageHoursTenthsPerGame === null
              ? '—'
              : formatHours(hours(Math.round(summary.averageHoursTenthsPerGame)))
          }
          hint="per game played"
        />
      </StatGroup>

      <StatGroup title="Money" description="What the library cost, and what's still sitting unplayed.">
        <StatCard label="Total spend" value={formatPriceCents(financial.totalSpendCents)} />
        <StatCard
          label="Average price"
          value={financial.averagePriceCents === null ? '—' : formatPriceCents(financial.averagePriceCents)}
          hint="per game"
        />
        <StatCard
          label="Cost per hour"
          value={financial.costPerHourCents === null ? '—' : `${formatPriceCents(financial.costPerHourCents)}/hr`}
        />
        <StatCard
          label="Backlog value"
          value={formatPriceCents(financial.backlogValueCents)}
          hint={`${financial.backlogCount} games waiting`}
        />
      </StatGroup>

      <Section title="Year by year" description="Every number here is computed from your library, not stored.">
        <YearlyBreakdownTable
          rows={yearly.rows}
          unattributedTenths={yearly.unattributedTenths}
          currentYear={currentYear}
        />
      </Section>

      <div className="space-y-3">
        <h2 className="text-sm font-medium">Trends</h2>
        <div className="grid gap-6 lg:grid-cols-3">
          <Section title="Games per year">
            <GamesPerYearChart rows={yearly.rows} />
          </Section>
          <Section title="Hours per year">
            <HoursPerYearChart rows={yearly.rows} />
          </Section>
          <Section title="Trophies per year">
            <TrophiesPerYearChart rows={yearly.rows} />
          </Section>
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-medium">Breakdown</h2>
        <div className="grid gap-6 lg:grid-cols-2">
          <Section title="Platforms">
            <DistributionChart slices={platforms} emptyMessage="No platforms recorded yet." />
          </Section>
          <Section title="Physical vs digital">
            <DistributionChart slices={ownership} emptyMessage="No ownership recorded yet." />
          </Section>
          <Section title="Genres">
            <DistributionChart slices={genres} emptyMessage="No genres yet — add cover art to fill these in." />
          </Section>
          <Section title="Ratings">
            <RatingDistributionChart rows={rows} />
          </Section>
        </div>
      </div>

      <Section title="Highlights">
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard
            label="Longest game"
            value={callouts.longestGame?.title ?? '—'}
            {...(callouts.longestGame === null
              ? {}
              : { hint: formatHours(hours(callouts.longestGame.hoursTenths)) })}
          />
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

function StatCard({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
}): React.ReactElement {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{label}</p>
      <p className="mt-2 truncate text-2xl font-semibold" title={value}>
        {value}
      </p>
      {hint === undefined ? null : <p className="text-muted-foreground mt-1 text-xs">{hint}</p>}
    </div>
  );
}

/**
 * A lightweight, unbordered heading over a row of `StatCard`s — grouping
 * related numbers (Library / Ratings & achievements / Money) without
 * stacking three more bordered boxes on top of `Section`'s own bordered
 * cards below. Deliberately not `Section` itself: a `Section`-in-front-of-
 * `Section` page reads as visually heavier, not more organized.
 */
function StatGroup({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-medium">{title}</h2>
        {description === undefined ? null : <p className="text-muted-foreground mt-1 text-xs">{description}</p>}
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="rounded-lg border p-4">
      <h2 className="text-sm font-medium">{title}</h2>
      {description === undefined ? null : (
        <p className="text-muted-foreground mt-1 mb-3 text-xs">{description}</p>
      )}
      <div className="mt-3">{children}</div>
    </section>
  );
}
