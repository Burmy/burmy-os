import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AnimeLogView } from '@/features/anime/log/log-view';
import { WatchLogList } from '@/features/anime/log/watch-log-list';
import type { WatchLogEntry } from '@/server/db/anime/watch-log';

/**
 * The Log tab and the list it shares with the show page's History section.
 *
 * The watermark cases are the point of this file: a log that begins in 2024
 * for someone who has watched since 2015 must READ as a stated limitation, not
 * as missing data, and that is a property only a render test can check.
 */

function entry(overrides: Partial<WatchLogEntry> & { readonly id: string }): WatchLogEntry {
  return {
    animeId: 'show-1',
    title: 'Frieren',
    coverUrl: null,
    watchedAt: new Date('2024-03-12T20:15:00'),
    episode: 4,
    kind: 'progress',
    ...overrides,
  };
}

describe('WatchLogList — grouping', () => {
  it('groups entries under one heading per day', () => {
    render(
      <WatchLogList
        entries={[
          entry({ id: 'a', episode: 6, watchedAt: new Date('2024-03-12T22:00:00') }),
          entry({ id: 'b', episode: 5, watchedAt: new Date('2024-03-12T21:00:00') }),
          entry({ id: 'c', episode: 4, watchedAt: new Date('2024-03-11T21:00:00') }),
        ]}
      />,
    );

    expect(screen.getByRole('heading', { name: /Mar 12, 2024/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Mar 11, 2024/ })).toBeInTheDocument();
  });

  it('counts the entries in each day, because a binge is the shape being read', () => {
    render(
      <WatchLogList
        entries={[
          entry({ id: 'a', watchedAt: new Date('2024-03-12T22:00:00') }),
          entry({ id: 'b', watchedAt: new Date('2024-03-12T21:00:00') }),
        ]}
      />,
    );
    expect(screen.getByRole('heading', { name: /2 entries/ })).toBeInTheDocument();
  });

  it('groups by LOCAL day, so a late-night episode stays on that evening', () => {
    // Bucketing by UTC would scatter one night's viewing across two headings
    // for anyone west of Greenwich.
    render(<WatchLogList entries={[entry({ id: 'a', watchedAt: new Date('2024-03-12T23:30:00') })]} />);
    expect(screen.getByRole('heading', { name: /Mar 12, 2024/ })).toBeInTheDocument();
  });
});

describe('WatchLogList — what an entry says', () => {
  it('names the episode when there is one', () => {
    render(<WatchLogList entries={[entry({ id: 'a', episode: 12 })]} />);
    expect(screen.getByText(/Episode 12/)).toBeInTheDocument();
  });

  it('says "Status changed" rather than printing an absent episode number', () => {
    // AniList records a bare "completed"/"dropped" with no progress. Neither
    // "Episode null" nor an empty cell is an acceptable rendering of that.
    render(<WatchLogList entries={[entry({ id: 'a', episode: null, kind: 'status' })]} />);
    expect(screen.getByText(/Status changed/)).toBeInTheDocument();
  });

  it('links each row to its show in the shared view', () => {
    render(<WatchLogList entries={[entry({ id: 'a', animeId: 'abc' })]} />);
    expect(screen.getByRole('link', { name: /Frieren/ })).toHaveAttribute('href', '/anime/abc');
  });

  it('gives the row an accessible name with real separators', () => {
    // REGRESSION. The visible text is a title, an event and a time in sibling
    // elements, and a computed name joins child nodes each TRIMMED — the row
    // read "FrierenEpisode 48:15 PM", which is nonsense and unqueryable.
    // Confirmed against the running page before this was fixed.
    render(<WatchLogList entries={[entry({ id: 'a', episode: 4 })]} />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('aria-label', expect.stringContaining('Frieren — Episode 4, '));
    expect(link.getAttribute('aria-label')).not.toMatch(/Episode 4\d/);
  });

  it('drops the title and the link on a single show’s own page', () => {
    // The title is already the page heading; repeating it on every row is noise.
    render(<WatchLogList entries={[entry({ id: 'a' })]} showTitles={false} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText('Frieren')).not.toBeInTheDocument();
  });
});

describe('AnimeLogView — the empty branch', () => {
  it('explains where the log comes from instead of showing an empty list', () => {
    render(<AnimeLogView entries={[]} bounds={{ total: 0, oldest: null, newest: null }} limit={500} />);

    expect(screen.getByText(/Your watch history comes from AniList/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /entries/ })).not.toBeInTheDocument();
  });

  it('shows no entry count at all when there is nothing to count', () => {
    render(<AnimeLogView entries={[]} bounds={{ total: 0, oldest: null, newest: null }} limit={500} />);
    expect(screen.queryByText(/0 entries/)).not.toBeInTheDocument();
  });
});

describe('AnimeLogView — the watermark', () => {
  const oldest = new Date('2024-03-11T21:00:00');

  it('states where the log begins, so a short history reads as a limit and not a bug', () => {
    render(
      <AnimeLogView
        entries={[entry({ id: 'a' })]}
        bounds={{ total: 1, oldest, newest: new Date('2026-08-29T10:00:00') }}
        limit={500}
      />,
    );

    expect(screen.getByText(/This log begins on/)).toBeInTheDocument();
    expect(
      screen.getByText(/AniList's activity feed does not reach back further/),
    ).toBeInTheDocument();
  });

  it('says when it is showing only the most recent page', () => {
    render(
      <AnimeLogView
        entries={[entry({ id: 'a' })]}
        bounds={{ total: 1200, oldest, newest: oldest }}
        limit={500}
      />,
    );
    expect(screen.getByText('Showing the 500 most recent of 1,200 entries.')).toBeInTheDocument();
  });

  it('says nothing about truncation when the whole log fits', () => {
    render(
      <AnimeLogView entries={[entry({ id: 'a' })]} bounds={{ total: 1, oldest, newest: oldest }} limit={500} />,
    );
    expect(screen.queryByText(/most recent of/)).not.toBeInTheDocument();
  });

  it('puts the total and the reach in the header', () => {
    render(
      <AnimeLogView
        entries={[entry({ id: 'a' })]}
        bounds={{ total: 1200, oldest, newest: oldest }}
        limit={500}
      />,
    );
    const header = screen.getByRole('heading', { name: 'Log' }).parentElement as HTMLElement;
    expect(within(header).getByText('1,200 entries')).toBeInTheDocument();
  });
});
