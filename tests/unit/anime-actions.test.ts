import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The one generic field-update action, and the series writes.
 *
 * These are Server Actions, so the DAL and `requireOwner` are mocked and what
 * is actually under test is the VALIDATION and the exhaustive switch — the two
 * things between a raw string typed in a browser and a column.
 */

const requireOwner = vi.fn(async () => ({ userId: 'owner-1' }));
vi.mock('@/server/auth/owner', () => ({ requireOwner: () => requireOwner() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const getAnime = vi.fn(async () => ({ id: 'a1', titleRomaji: 'Shingeki no Kyojin Season 3' }));
const updateAnime = vi.fn(async () => ({}));
const createAnime = vi.fn(async () => ({}));
const deleteAnime = vi.fn(async () => undefined);
vi.mock('@/server/db/anime/anime', () => ({
  getAnime: (...a: unknown[]) => getAnime(...(a as [])),
  updateAnime: (...a: unknown[]) => updateAnime(...(a as [])),
  createAnime: (...a: unknown[]) => createAnime(...(a as [])),
  deleteAnime: (...a: unknown[]) => deleteAnime(...(a as [])),
}));

const setSeriesForAnime = vi.fn(async () => 1);
const createSeries = vi.fn(async () => ({ id: 'new-series', title: 'Shingeki no Kyojin' }));
vi.mock('@/server/db/anime/series', () => ({
  setSeriesForAnime: (...a: unknown[]) => setSeriesForAnime(...(a as [])),
  createSeries: (...a: unknown[]) => createSeries(...(a as [])),
  renameSeries: vi.fn(async () => undefined),
  deleteSeries: vi.fn(async () => undefined),
}));

const {
  createSeriesForAnimeAction,
  setAnimeSeriesAction,
  updateAnimeFieldAction,
} = await import('@/features/anime/anime-actions');

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

beforeEach(() => {
  updateAnime.mockClear();
  setSeriesForAnime.mockClear();
  createSeries.mockClear();
});

describe('updateAnimeFieldAction — validation', () => {
  it('writes a valid value through', async () => {
    const result = await updateAnimeFieldAction(ID, 'studio', '  Wit Studio  ');
    expect(result.ok).toBe(true);
    expect(updateAnime).toHaveBeenCalledWith('owner-1', ID, { studio: 'Wit Studio' });
  });

  it('clears an optional field on an empty commit', async () => {
    await updateAnimeFieldAction(ID, 'studio', '   ');
    expect(updateAnime).toHaveBeenCalledWith('owner-1', ID, { studio: null });
  });

  it('refuses to blank the title, rather than clearing it', async () => {
    // `titleRomaji` has no null branch; its own `min(1)` rejects the empty
    // string on its own terms.
    const result = await updateAnimeFieldAction(ID, 'titleRomaji', '  ');
    expect(result).toEqual({ ok: false, error: 'Title is required' });
    expect(updateAnime).not.toHaveBeenCalled();
  });

  it('treats an empty progress as zero, not as unknown', async () => {
    // Progress is `not null` in the schema. "Back to zero" is a real answer;
    // "unknown" is not a state this column can hold.
    await updateAnimeFieldAction(ID, 'progress', '');
    expect(updateAnime).toHaveBeenCalledWith('owner-1', ID, { progress: 0 });
  });

  it('rejects a status that is not in the taxonomy', async () => {
    const result = await updateAnimeFieldAction(ID, 'status', 'paused');
    expect(result.ok).toBe(false);
    expect(updateAnime).not.toHaveBeenCalled();
  });

  it('rejects an episode count past the smallint ceiling', async () => {
    // Not politeness: an out-of-range value reaches Postgres as an error that
    // surfaces as a 500 instead of a field message.
    const result = await updateAnimeFieldAction(ID, 'episodes', '99999');
    expect(result.ok).toBe(false);
  });

  it('accepts a real long-runner well inside that ceiling', async () => {
    await updateAnimeFieldAction(ID, 'progress', '1094');
    expect(updateAnime).toHaveBeenCalledWith('owner-1', ID, { progress: 1094 });
  });

  it('does NOT clamp progress to the episode count', async () => {
    // AniList regularly carries progress past a stale total while a show is
    // airing. Refusing the owner's own number because a third-party total has
    // not caught up would be the app arguing with the person who watched it.
    await updateAnimeFieldAction(ID, 'progress', '9000');
    expect(updateAnime).toHaveBeenCalledWith('owner-1', ID, { progress: 9000 });
  });

  it('requires a real date shape, not any string', async () => {
    const bad = await updateAnimeFieldAction(ID, 'startedAt', 'last summer');
    expect(bad).toEqual({ ok: false, error: 'Use YYYY-MM-DD' });

    await updateAnimeFieldAction(ID, 'startedAt', '2023-10-01');
    expect(updateAnime).toHaveBeenCalledWith('owner-1', ID, { startedAt: '2023-10-01' });
  });

  it('rejects a cover that is not a URL', async () => {
    const result = await updateAnimeFieldAction(ID, 'coverUrl', 'not a url');
    expect(result.ok).toBe(false);
  });

  it('refuses a malformed id before touching the database', async () => {
    const result = await updateAnimeFieldAction('not-a-uuid', 'studio', 'Bones');
    expect(result.ok).toBe(false);
    expect(updateAnime).not.toHaveBeenCalled();
  });
});

describe('setAnimeSeriesAction', () => {
  it('files a show into a series', async () => {
    const seriesId = 'ffffffff-1111-4222-8333-444444444444';
    await setAnimeSeriesAction(ID, seriesId);
    expect(setSeriesForAnime).toHaveBeenCalledWith('owner-1', [ID], seriesId);
  });

  it('treats an empty string the same as null, so a cleared picker removes membership', async () => {
    await setAnimeSeriesAction(ID, '');
    expect(setSeriesForAnime).toHaveBeenCalledWith('owner-1', [ID], null);
  });
});

describe('createSeriesForAnimeAction', () => {
  it('suggests a franchise name from the season title, then files the show in', async () => {
    const result = await createSeriesForAnimeAction(ID);
    expect(createSeries).toHaveBeenCalledWith('owner-1', { title: 'Shingeki no Kyojin' });
    expect(setSeriesForAnime).toHaveBeenCalledWith('owner-1', [ID], 'new-series');
    expect(result).toMatchObject({ ok: true, seriesId: 'new-series' });
  });

  it('uses an explicit name when one is given', async () => {
    await createSeriesForAnimeAction(ID, '  Attack on Titan  ');
    expect(createSeries).toHaveBeenCalledWith('owner-1', { title: 'Attack on Titan' });
  });
});
