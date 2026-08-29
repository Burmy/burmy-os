import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

/**
 * The series page and its members panel — the "gather a franchise" end of
 * series membership. Its counterpart, `SeriesField` on a show's own page, is
 * covered below in the same file because the two write the same column and the
 * point of having both is that either one alone is the wrong tool half the
 * time.
 */

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const addAnimeToSeriesAction = vi.fn(async () => ({ ok: true as const }));
const setAnimeSeriesAction = vi.fn(async () => ({ ok: true as const }));
const deleteSeriesAction = vi.fn(async () => ({ ok: true as const }));
const renameSeriesAction = vi.fn(async () => ({ ok: true as const }));

vi.mock('@/features/anime/anime-actions', () => ({
  addAnimeToSeriesAction: (...a: unknown[]) => addAnimeToSeriesAction(...(a as [])),
  setAnimeSeriesAction: (...a: unknown[]) => setAnimeSeriesAction(...(a as [])),
  deleteSeriesAction: (...a: unknown[]) => deleteSeriesAction(...(a as [])),
  renameSeriesAction: (...a: unknown[]) => renameSeriesAction(...(a as [])),
}));

const toastError = vi.fn();
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: toastError } }));

const { SeriesPage } = await import('@/features/anime/series/series-page');
const { SeriesField } = await import('@/features/anime/series/series-field');

type Member = Parameters<typeof SeriesPage>[0]['members'][number];

function member(overrides: Partial<Member> & { readonly id: string }): Member {
  return {
    seriesId: 'aot',
    anilistMediaId: null,
    titleRomaji: overrides.id,
    titleEnglish: null,
    format: 'tv',
    status: 'completed',
    episodes: 12,
    progress: 12,
    repeatCount: 0,
    durationMinutes: 24,
    season: 'spring',
    seasonYear: 2020,
    studio: null,
    genre: null,
    source: null,
    synopsis: null,
    coverUrl: null,
    notes: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

const SERIES = { id: 'aot', title: 'Attack on Titan', coverUrl: null, anilistParentId: null };

const MEMBERS: Member[] = [
  member({ id: 's1', titleRomaji: 'Season 1', episodes: 25, progress: 25, seasonYear: 2013 }),
  member({ id: 's2', titleRomaji: 'Season 2', seasonYear: 2017 }),
];

describe('SeriesPage — derived totals', () => {
  it('counts its members as shows, never itself', () => {
    render(<SeriesPage series={SERIES} members={MEMBERS} candidates={[]} />);
    const card = screen.getByText('Shows').parentElement as HTMLElement;
    expect(within(card).getByText('2')).toBeInTheDocument();
  });

  it('reports time watched as an estimate, never as a measurement', () => {
    render(<SeriesPage series={SERIES} members={MEMBERS} candidates={[]} />);
    expect(screen.getByText(/^≈/)).toBeInTheDocument();
    expect(screen.getByText('Estimated from average episode lengths.')).toBeInTheDocument();
  });

  it('says so plainly when no member has a known episode length', () => {
    // "we do not know" and "zero" are different answers.
    render(
      <SeriesPage
        series={SERIES}
        members={[member({ id: 's1', durationMinutes: null })]}
        candidates={[]}
      />,
    );
    expect(screen.getByText('No member has a known episode length.')).toBeInTheDocument();
  });

  it('collapses the airing span to one year when every member aired in it', () => {
    render(<SeriesPage series={SERIES} members={[member({ id: 's1', seasonYear: 2013 })]} candidates={[]} />);
    expect(screen.getAllByText('2013').length).toBeGreaterThan(0);
  });

  it('is empty, not broken, for a series with nothing in it yet', () => {
    render(<SeriesPage series={SERIES} members={[]} candidates={[]} />);
    expect(screen.getByText(/Nothing in this series yet/)).toBeInTheDocument();
  });
});

describe('SeriesPage — dissolving', () => {
  it('says the shows survive, because "delete" beside a list of six invites the opposite assumption', async () => {
    const user = userEvent.setup();
    render(<SeriesPage series={SERIES} members={MEMBERS} candidates={[]} />);

    await user.click(screen.getByRole('button', { name: 'Dissolve' }));
    expect(
      screen.getByText(/The 2 shows inside will stay in your library as standalone entries/),
    ).toBeInTheDocument();
  });

  it('does not promise surviving shows when there are none', async () => {
    const user = userEvent.setup();
    render(<SeriesPage series={SERIES} members={[]} candidates={[]} />);

    await user.click(screen.getByRole('button', { name: 'Dissolve' }));
    expect(screen.getByText('This removes the series. Nothing else changes.')).toBeInTheDocument();
  });
});

describe('SeriesMembersPanel — adding and removing', () => {
  it('names the show AND the series on each remove button', async () => {
    // A franchise of near-identical season titles makes a bare "Remove" read
    // identically on every button in the list to a screen reader.
    render(<SeriesPage series={SERIES} members={MEMBERS} candidates={[]} />);
    expect(screen.getByRole('button', { name: 'Remove Season 1 from Attack on Titan' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Season 2 from Attack on Titan' })).toBeInTheDocument();
  });

  it('files the picked shows into this series', async () => {
    const user = userEvent.setup();
    render(
      <SeriesPage
        series={SERIES}
        members={MEMBERS}
        candidates={[{ id: 's3', title: 'Season 3', subtitle: 'Summer 2018' }]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Add shows' }));
    await user.click(screen.getByRole('button', { name: 'Season 3 — Summer 2018' }));
    await user.click(screen.getByRole('button', { name: 'Add to series' }));

    expect(addAnimeToSeriesAction).toHaveBeenCalledWith('aot', ['s3']);
  });

  it('never re-sends a show that is already a member', async () => {
    // The picker renders current members checked, so a confirm can carry ids
    // already in — filtering keeps the toast's count honest.
    addAnimeToSeriesAction.mockClear();
    const user = userEvent.setup();
    render(
      <SeriesPage
        series={SERIES}
        members={MEMBERS}
        candidates={[{ id: 's1', title: 'Season 1' }]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Add shows' }));
    await user.click(screen.getByRole('button', { name: 'Add to series' }));

    expect(addAnimeToSeriesAction).not.toHaveBeenCalled();
  });

  it('removes a show by clearing its series, never by deleting it', async () => {
    const user = userEvent.setup();
    render(<SeriesPage series={SERIES} members={MEMBERS} candidates={[]} />);

    await user.click(screen.getByRole('button', { name: 'Remove Season 1 from Attack on Titan' }));
    expect(setAnimeSeriesAction).toHaveBeenCalledWith('s1', null);
  });
});

describe('SeriesField — the other end', () => {
  it('offers "New series" only when the show is in none', () => {
    // A show already in a franchise does not need a second one; the picker is
    // how it moves.
    const { rerender } = render(
      <SeriesField series={null} options={[]} onSave={vi.fn()} onCreate={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'New series' })).toBeInTheDocument();

    rerender(
      <SeriesField
        series={{ id: 'aot', title: 'Attack on Titan' }}
        options={[]}
        onSave={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'New series' })).not.toBeInTheDocument();
  });

  it('offers the clear X only when there is something to clear', () => {
    const { rerender } = render(
      <SeriesField series={null} options={[]} onSave={vi.fn()} onCreate={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: /^Remove from/ })).not.toBeInTheDocument();

    rerender(
      <SeriesField
        series={{ id: 'aot', title: 'Attack on Titan' }}
        options={[]}
        onSave={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Remove from Attack on Titan' })).toBeInTheDocument();
  });

  it('reads "Part of <series>" as its accessible name, without repeating the label in the visible text', () => {
    render(
      <SeriesField
        series={{ id: 'aot', title: 'Attack on Titan' }}
        options={[]}
        onSave={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Part of Attack on Titan' })).toBeInTheDocument();
  });

  it('re-enables itself when the action REJECTS rather than returning a failure', async () => {
    // A rejected Server Action skips every line after its `await`, which is how
    // the Games duplicates screen once stranded every button disabled.
    const onSave = vi.fn().mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    render(
      <SeriesField
        series={{ id: 'aot', title: 'Attack on Titan' }}
        options={[]}
        onSave={onSave}
        onCreate={vi.fn()}
      />,
    );

    const clear = screen.getByRole('button', { name: 'Remove from Attack on Titan' });
    await user.click(clear);

    expect(toastError).toHaveBeenCalledWith('That did not save. Nothing was changed.');
    expect(clear).toBeEnabled();
  });
});
