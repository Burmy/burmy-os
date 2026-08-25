import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TopGames } from '@/features/games/dashboard/top-games';
import type { LeaderboardEntry } from '@/server/games/stats';

function entry(overrides: Partial<LeaderboardEntry> = {}): LeaderboardEntry {
  return { id: 'g1', title: 'Elden Ring', coverUrl: null, platform: 'ps5', value: 1360, ...overrides };
}

/**
 * `buildLeaderboard` hands back each metric in its own raw unit, so this
 * component owns all four formatting branches. Getting one wrong renders a
 * plausible-looking but meaningless number, which no type would catch.
 */
describe('TopGames', () => {
  it('formats hours', () => {
    render(<TopGames title="Most played" hint="h" metric="hours" entries={[entry({ value: 1360 })]} />);
    expect(screen.getByText('136h')).toBeInTheDocument();
  });

  it('formats a rating out of five', () => {
    render(<TopGames title="Highest rated" hint="h" metric="rating" entries={[entry({ value: 5 })]} />);
    expect(screen.getByText('5★')).toBeInTheDocument();
  });

  it('formats a trophy count as a plain number', () => {
    render(<TopGames title="Most trophies" hint="h" metric="trophies" entries={[entry({ value: 154 })]} />);
    expect(screen.getByText('154')).toBeInTheDocument();
  });

  it('formats cost per hour as money, not as raw cents', () => {
    render(<TopGames title="Best value" hint="h" metric="costPerHour" entries={[entry({ value: 4 })]} />);
    expect(screen.getByText('$0.04/h')).toBeInTheDocument();
  });

  it('ranks entries from one', () => {
    render(
      <TopGames
        title="Most played"
        hint="h"
        metric="hours"
        entries={[entry({ id: 'a', title: 'First' }), entry({ id: 'b', title: 'Second' })]}
      />,
    );
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('shows the title initial when a game has no cover art', () => {
    render(<TopGames title="Most played" hint="h" metric="hours" entries={[entry({ coverUrl: null })]} />);
    expect(screen.getByText('E')).toBeInTheDocument();
  });

  it('renders an empty state rather than a bare heading when nothing qualifies', () => {
    render(<TopGames title="Best value" hint="h" metric="costPerHour" entries={[]} />);
    expect(screen.getByText(/nothing to rank yet/i)).toBeInTheDocument();
  });
});
