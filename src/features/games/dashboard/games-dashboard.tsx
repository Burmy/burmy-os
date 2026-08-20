import { formatHours, hours } from '@/server/games/hours';
import {
  type GameStatRow,
  buildDistribution,
  buildLibrarySummary,
  buildYearlyBreakdown,
  findCallouts,
} from '@/server/games/stats';
import { type GamePlatform, PLATFORM_LABELS } from '@/server/games/taxonomy';
import { DistributionChart } from './charts/distribution-chart';
import { GamesPerYearChart } from './charts/games-per-year-chart';
import { HoursPerYearChart } from './charts/hours-per-year-chart';
import { RatingDistributionChart } from './charts/rating-distribution-chart';
import { YearlyBreakdownTable } from './yearly-breakdown-table';

export function GamesDashboard({
  rows,
  currentYear,
}: {
  readonly rows: readonly GameStatRow[];
  readonly currentYear: number;
}): React.ReactElement {
  const summary = buildLibrarySummary(rows);
  const yearly = buildYearlyBreakdown(rows);
  const callouts = findCallouts(rows);

  const platforms = buildDistribution(rows, (row) => row.platform, (key) => PLATFORM_LABELS[key as GamePlatform]);
  const ownership = buildDistribution(rows, (row) => row.ownership, (key) => (key === 'physical' ? 'Physical' : 'Digital'));
  const genres = buildDistribution(rows, (row) => row.genre, (key) => key);

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Games" value={String(summary.totalGames)} />
        <StatCard label="Hours played" value={formatHours(hours(summary.totalHoursTenths))} />
        <StatCard
          label="Average rating"
          value={summary.averageRating === null ? '—' : `${summary.averageRating.toFixed(1)} / 5`}
        />
        <StatCard label="Backlog" value={String(summary.backlogCount)} hint={`${summary.playingCount} in progress`} />
        <StatCard
          label="Completion rate"
          value={summary.completionRatePercent === null ? '—' : `${summary.completionRatePercent.toFixed(0)}%`}
          hint="of games started"
        />
      </div>

      <Section title="Year by year" description="Every number here is computed from your library, not stored.">
        <YearlyBreakdownTable rows={yearly} currentYear={currentYear} />
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Hours per year">
          <HoursPerYearChart rows={yearly} />
        </Section>
        <Section title="Games per year">
          <GamesPerYearChart rows={yearly} />
        </Section>
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
