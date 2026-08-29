import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

/**
 * The AniList review screen.
 *
 * A render test rather than a pure-function test on purpose: this screen has
 * an ALL-OR-NOTHING branch (nothing to review vs. the tables), and the
 * discipline this codebase adopted after the Finance dashboard shipped two
 * bugs behind 1,267 green unit tests is that such a branch gets a render test
 * per branch, asserting which block is actually on screen.
 */

const setAnimeSyncChangeSelectedAction = vi.fn(async () => ({ ok: true as const }));
const commitAnimeSyncRunAction = vi.fn(async () => ({ ok: true as const, applied: 0, created: 0, skipped: 0 }));

const importAnimeActivityAction = vi.fn(async () => ({ ok: true as const, imported: 0, skipped: 0 }));

vi.mock('@/features/anime/sync/sync-actions', () => ({
  setAnimeSyncChangeSelectedAction,
  commitAnimeSyncRunAction,
  importAnimeActivityAction,
}));

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const toastError = vi.fn();
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: toastError } }));

const { AnimeSyncReview } = await import('@/features/anime/sync/sync-review');

type Run = Parameters<typeof AnimeSyncReview>[0]['run'];
type Change = Parameters<typeof AnimeSyncReview>[0]['changes'][number];

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'e0f3b2a4-0000-4000-8000-000000000001',
    status: 'ready',
    cursor: 8,
    total: 8,
    lastAnimeId: null,
    errorMessage: null,
    createdAt: new Date('2026-08-29T00:00:00Z'),
    ...overrides,
  };
}

function makeChange(overrides: Partial<Change>): Change {
  return {
    id: 'change-1',
    kind: 'field_update',
    animeId: 'anime-1',
    title: 'A Show',
    payload: {},
    selected: true,
    ...overrides,
  };
}

describe('AnimeSyncReview — the empty branch', () => {
  it('says the library already matches instead of rendering empty tables', () => {
    render(<AnimeSyncReview run={makeRun()} changes={[]} />);

    expect(screen.getByText('Nothing to review.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Apply/ })).not.toBeInTheDocument();
  });

  it('STILL imports the watch log on the way out', async () => {
    // A run with no library changes is a run that ends here, and it is exactly
    // the case where new activity can still exist — a rewatch, a status change,
    // an episode another device already reported. Hanging the import off the
    // commit alone would make the log stop updating once the library caught up.
    importAnimeActivityAction.mockClear();
    const user = userEvent.setup();
    render(<AnimeSyncReview run={makeRun()} changes={[]} />);

    await user.click(screen.getByRole('button', { name: 'Back to library' }));

    expect(importAnimeActivityAction).toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith('/anime/library');
  });

  it('leaves anyway when the log import fails', async () => {
    // Best-effort: the library is already correct, so a failed feed must not
    // strand the owner on a review screen with nothing left to review.
    importAnimeActivityAction.mockRejectedValueOnce(new Error('feed down'));
    const user = userEvent.setup();
    render(<AnimeSyncReview run={makeRun()} changes={[]} />);

    await user.click(screen.getByRole('button', { name: 'Back to library' }));

    expect(toastError).toHaveBeenCalledWith(
      'The watch log could not be imported. Your library is still up to date.',
    );
    expect(push).toHaveBeenCalledWith('/anime/library');
  });
});

describe('AnimeSyncReview — the populated branch', () => {
  it('groups changes by kind, each under its own heading', () => {
    render(
      <AnimeSyncReview
        run={makeRun()}
        changes={[
          makeChange({ id: 'n1', kind: 'new_anime', animeId: null, title: 'Frieren', payload: { status: 'completed', progress: 28, episodes: 28 } }),
          makeChange({ id: 'f1', payload: { field: 'progress', from: 10, to: 12 } }),
          makeChange({ id: 'l1', kind: 'link', payload: { anilistMediaId: 21 } }),
          makeChange({
            id: 's1',
            kind: 'series_hint',
            animeId: null,
            title: 'Attack on Titan',
            selected: false,
            payload: {
              anilistParentId: 16498,
              seriesTitle: 'Attack on Titan',
              mediaIds: [16498, 25777],
              titles: ['Shingeki no Kyojin', 'Shingeki no Kyojin Season 2'],
            },
          }),
        ]}
      />,
    );

    expect(screen.getByRole('heading', { name: 'New shows (1)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Field updates' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Links' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Series to group' })).toBeInTheDocument();
  });

  it('counts only the selected changes on the apply button', () => {
    render(
      <AnimeSyncReview
        run={makeRun()}
        changes={[
          makeChange({ id: 'f1', payload: { field: 'progress', from: 1, to: 2 } }),
          makeChange({ id: 'f2', payload: { field: 'progress', from: 3, to: 4 } }),
          makeChange({ id: 's1', kind: 'series_hint', animeId: null, selected: false, payload: {} }),
        ]}
      />,
    );

    expect(screen.getByRole('button', { name: 'Apply 2 selected changes' })).toBeInTheDocument();
  });

  it('cannot apply when nothing is selected', () => {
    render(
      <AnimeSyncReview
        run={makeRun()}
        changes={[makeChange({ id: 's1', kind: 'series_hint', animeId: null, selected: false, payload: {} })]}
      />,
    );

    expect(screen.getByRole('button', { name: 'Apply 0 selected changes' })).toBeDisabled();
  });
});

describe('AnimeSyncReview — series grouping', () => {
  function hint(overrides: Partial<Change> = {}): Change {
    return makeChange({
      id: 'h1',
      kind: 'series_hint',
      animeId: null,
      title: 'Attack on Titan',
      selected: false,
      payload: {
        anilistParentId: 16498,
        seriesTitle: 'Attack on Titan',
        mediaIds: [16498, 25777, 99147],
        titles: ['Shingeki no Kyojin', 'Shingeki no Kyojin Season 2', 'Shingeki no Kyojin Season 3'],
      },
      ...overrides,
    });
  }

  it('lists every show it would group, one per line', () => {
    // This is the only information the owner has to judge the proposal on — a
    // recap film wrongly attached is exactly what they are being asked to
    // catch, so it has to be readable rather than a joined run.
    render(<AnimeSyncReview run={makeRun()} changes={[hint()]} />);
    const items = screen.getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Shingeki no Kyojin',
      'Shingeki no Kyojin Season 2',
      'Shingeki no Kyojin Season 3',
    ]);
  });

  it('says approving one actually files them, not that it is advisory', () => {
    // It WAS advisory, and applied nothing — a checkbox that counted toward
    // "Apply N selected changes" and did nothing at all.
    render(<AnimeSyncReview run={makeRun()} changes={[hint()]} />);
    expect(screen.getByText(/Approving one files them under a single series/)).toBeInTheDocument();
  });

  it('arrives unticked, so it cannot be approved by clicking through', () => {
    render(<AnimeSyncReview run={makeRun()} changes={[hint()]} />);
    expect(screen.getByRole('checkbox', { name: 'Include Attack on Titan' })).not.toBeChecked();
  });
});

describe('AnimeSyncReview — links', () => {
  it('shows YOUR title beside AniList’s, so a wrong match can be caught', () => {
    // A link now comes from a TITLE match on a hand-added show. "Matched to
    // #16498" is unverifiable, and approving it is the only thing standing
    // between a wrong match and a later sync overwriting the show.
    render(
      <AnimeSyncReview
        run={makeRun()}
        changes={[
          makeChange({
            id: 'l1',
            kind: 'link',
            title: 'Attack on Titan',
            payload: { anilistMediaId: 16498, matchedTitle: 'Shingeki no Kyojin' },
          }),
        ]}
      />,
    );

    const row = screen.getByRole('row', { name: /Attack on Titan/ });
    expect(within(row).getByText('Shingeki no Kyojin')).toBeInTheDocument();
    expect(within(row).getByText('#16498')).toBeInTheDocument();
  });
});

describe('AnimeSyncReview — a progress decrease', () => {
  it('labels it rather than rendering it as any other number moving', () => {
    // The one field change that can destroy something real. `planLinkedAnimeChanges`
    // stages it instead of blocking it, on the condition that this screen makes
    // it impossible to approve by reflex.
    render(
      <AnimeSyncReview
        run={makeRun()}
        changes={[makeChange({ payload: { field: 'progress', from: 24, to: 3, decrease: true } })]}
      />,
    );

    expect(screen.getByText('Moves your progress backwards.')).toBeInTheDocument();
    expect(screen.getByText('24 → 3')).toBeInTheDocument();
  });

  it('says nothing extra when progress moves forward', () => {
    render(
      <AnimeSyncReview
        run={makeRun()}
        changes={[makeChange({ payload: { field: 'progress', from: 3, to: 24 } })]}
      />,
    );

    expect(screen.queryByText('Moves your progress backwards.')).not.toBeInTheDocument();
  });
});

describe('AnimeSyncReview — field rendering', () => {
  it('shows a status change as its label, not its enum value', () => {
    render(
      <AnimeSyncReview
        run={makeRun()}
        changes={[makeChange({ payload: { field: 'status', from: 'watching', to: 'completed' } })]}
      />,
    );

    expect(screen.getByText('Watching → Completed')).toBeInTheDocument();
  });

  it('never prints a raw cover URL — it says whether art is arriving', () => {
    // 100+ characters of CDN path in a table cell tells the owner nothing and
    // wrecks the column widths.
    render(
      <AnimeSyncReview
        run={makeRun()}
        changes={[
          makeChange({
            payload: { field: 'coverUrl', from: null, to: 'https://s4.anilist.co/file/anilistcdn/x/y/z.jpg' },
          }),
        ]}
      />,
    );

    expect(screen.getByText('— → an image')).toBeInTheDocument();
    expect(screen.queryByText(/anilistcdn/)).not.toBeInTheDocument();
  });

  it('degrades a malformed payload to a placeholder instead of throwing', () => {
    // This is a read-only screen: refusing to render protects nothing, unlike
    // the commit path's exhaustive switch.
    render(<AnimeSyncReview run={makeRun()} changes={[makeChange({ payload: { field: 'progress', from: {}, to: [] } })]} />);

    expect(screen.getByText('— → —')).toBeInTheDocument();
  });
});

describe('AnimeSyncReview — selection', () => {
  it('reverts the checkbox when the Server Action reports failure', async () => {
    setAnimeSyncChangeSelectedAction.mockResolvedValueOnce({ ok: false, error: 'nope' } as never);
    const user = userEvent.setup();

    render(
      <AnimeSyncReview
        run={makeRun()}
        changes={[makeChange({ title: 'Frieren', payload: { field: 'progress', from: 1, to: 2 } })]}
      />,
    );

    const checkbox = screen.getByRole('checkbox', { name: 'Include Frieren' });
    await user.click(checkbox);

    expect(toastError).toHaveBeenCalledWith('nope');
    expect(checkbox).toBeChecked();
  });
});

describe('AnimeSyncReview — a rejected commit', () => {
  it('re-enables the button instead of stranding it disabled forever', async () => {
    // REGRESSION-shaped. A Server Action that REJECTS skips every line after
    // its `await`, including the one that clears the pending flag — exactly how
    // the Games duplicates screen once left every Merge button dead with no
    // error shown and no way back but a reload.
    commitAnimeSyncRunAction.mockRejectedValueOnce(new Error('boom'));
    const user = userEvent.setup();

    render(
      <AnimeSyncReview run={makeRun()} changes={[makeChange({ payload: { field: 'progress', from: 1, to: 2 } })]} />,
    );

    const apply = screen.getByRole('button', { name: 'Apply 1 selected change' });
    await user.click(apply);

    expect(toastError).toHaveBeenCalledWith('Applying the changes failed. Nothing was saved.');
    expect(apply).toBeEnabled();
  });
});

describe('AnimeSyncReview — a large first import', () => {
  it('warns when the new-show count crosses the volume threshold', () => {
    const many = Array.from({ length: 101 }, (_, index) =>
      makeChange({ id: `n${index}`, kind: 'new_anime', animeId: null, title: `Show ${index}`, payload: {} }),
    );

    render(<AnimeSyncReview run={makeRun()} changes={many} />);

    const heading = screen.getByRole('heading', { name: 'New shows (101)' });
    expect(within(heading.parentElement as HTMLElement).getByText(/read it before applying/)).toBeInTheDocument();
  });
});
