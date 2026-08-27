import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const setSyncChangeSelectedAction = vi.fn(async () => ({ ok: true as const }));
const commitSyncRunAction = vi.fn(async () => ({ ok: true as const, applied: 0, created: 0, skipped: 0 }));

vi.mock('@/features/games/sync/sync-actions', () => ({
  setSyncChangeSelectedAction,
  commitSyncRunAction,
}));

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { SyncReview } = await import('@/features/games/sync/sync-review');

type SyncRun = Parameters<typeof SyncReview>[0]['run'];
type SyncChange = Parameters<typeof SyncReview>[0]['changes'][number];

function makeRun(overrides: Partial<SyncRun> = {}): SyncRun {
  return {
    id: 'run-1',
    source: 'steam',
    status: 'ready',
    cursor: 3,
    total: 3,
    lastGameId: null,
    errorMessage: null,
    ...overrides,
  };
}

function makeChange(overrides: Partial<SyncChange>): SyncChange {
  return {
    id: 'change-1',
    kind: 'field_update',
    gameId: 'game-1',
    title: 'A Game',
    payload: {},
    selected: true,
    ...overrides,
  };
}

describe('SyncReview', () => {
  it('renders needs-attention items first', () => {
    render(
      <SyncReview
        run={makeRun()}
        changes={[
          makeChange({
            id: 'link-1',
            kind: 'link',
            title: 'Celeste',
            payload: { steamAppid: 504230 },
            selected: true,
          }),
          makeChange({
            id: 'reconcile-1',
            kind: 'reconcile',
            title: 'Hollow Knight',
            payload: { splitTenths: 4900, newTotalTenths: 6000, differenceTenths: 1100 },
            selected: false,
          }),
        ]}
      />,
    );

    const headings = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    expect(headings[0]).toBe('Needs attention');
    expect(headings.indexOf('Needs attention')).toBeLessThan(headings.indexOf('Links'));
  });

  it('leaves reconcile items unselected by default', () => {
    render(
      <SyncReview
        run={makeRun()}
        changes={[
          makeChange({
            id: 'reconcile-1',
            kind: 'reconcile',
            title: 'Hollow Knight',
            payload: { splitTenths: 4900, newTotalTenths: 6000, differenceTenths: 1100 },
            selected: false,
          }),
        ]}
      />,
    );

    expect(screen.getByRole('checkbox', { name: /Hollow Knight/i })).not.toBeChecked();
  });

  it('pre-selects new games', () => {
    render(
      <SyncReview
        run={makeRun()}
        changes={[
          makeChange({
            id: 'new-1',
            kind: 'new_game',
            gameId: null,
            title: 'Portal',
            payload: { steamAppid: 400, hoursTenths: 400, platform: 'steam' },
            selected: true,
          }),
        ]}
      />,
    );

    expect(screen.getByRole('checkbox', { name: /Portal/i })).toBeChecked();
  });

  it('shows a real before and after for a field update', () => {
    render(
      <SyncReview
        run={makeRun()}
        changes={[
          makeChange({
            id: 'field-1',
            kind: 'field_update',
            title: 'Hollow Knight',
            payload: { field: 'hoursTenths', from: 490, to: 510 },
            selected: true,
          }),
        ]}
      />,
    );

    expect(screen.getByText('49h → 51h')).toBeInTheDocument();
  });

  it('disables the apply button when nothing is selected', () => {
    render(
      <SyncReview
        run={makeRun()}
        changes={[
          makeChange({
            id: 'reconcile-1',
            kind: 'reconcile',
            title: 'Hollow Knight',
            payload: { splitTenths: 4900, newTotalTenths: 6000, differenceTenths: 1100 },
            selected: false,
          }),
        ]}
      />,
    );

    expect(screen.getByRole('button', { name: /apply/i })).toBeDisabled();
  });

  it('renders an empty state when a run produced no changes', () => {
    render(<SyncReview run={makeRun()} changes={[]} />);

    expect(screen.getByText(/nothing to review/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows the new-game count in the group header without a warning under the volume threshold', () => {
    const changes = Array.from({ length: 5 }, (_, i) =>
      makeChange({
        id: `new-${i}`,
        kind: 'new_game',
        gameId: null,
        title: `Game ${i}`,
        payload: { hoursTenths: 0 },
        selected: true,
      }),
    );

    render(<SyncReview run={makeRun()} changes={changes} />);

    expect(screen.getByRole('heading', { level: 2, name: 'New games (5)' })).toBeInTheDocument();
    expect(screen.queryByText(/review carefully before applying/i)).toBeNull();
  });

  it('states the count prominently BEFORE approval when a run stages more than 100 new games', () => {
    // The owner's stated fear: a full PSN mirror returning demos and PS Plus
    // claims must never be silently approvable — the volume has to be
    // visible in the group header itself, not just discoverable by scrolling
    // the table.
    const changes = Array.from({ length: 101 }, (_, i) =>
      makeChange({
        id: `new-${i}`,
        kind: 'new_game',
        gameId: null,
        title: `Game ${i}`,
        payload: { hoursTenths: 0 },
        selected: true,
      }),
    );

    render(<SyncReview run={makeRun()} changes={changes} />);

    expect(screen.getByRole('heading', { level: 2, name: 'New games (101)' })).toBeInTheDocument();
    expect(screen.getByText(/101 new games found — review carefully before applying/i)).toBeInTheDocument();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Task 4: PSN-aware labels. `run.source === 'psn'` changes the same
  // screen's wording and the Links column, and PSN's field_update payloads
  // carry string/boolean values the pre-existing number-only formatter
  // never had to handle.
  // ───────────────────────────────────────────────────────────────────────

  it('shows a PlayStation title id (not a Steam appid) for a PSN link change', () => {
    render(
      <SyncReview
        run={makeRun({ source: 'psn' })}
        changes={[
          makeChange({
            id: 'link-1',
            kind: 'link',
            title: 'Bloodborne',
            payload: { psnTitleId: 'CUSA00552_00' },
            selected: true,
          }),
        ]}
      />,
    );

    expect(screen.getByRole('columnheader', { name: 'PlayStation IDs' })).toBeInTheDocument();
    expect(screen.getByText('Title CUSA00552_00')).toBeInTheDocument();
  });

  it('shows both the title and trophy ids when a PSN link change carries both', () => {
    render(
      <SyncReview
        run={makeRun({ source: 'psn' })}
        changes={[
          makeChange({
            id: 'link-1',
            kind: 'link',
            title: 'Bloodborne',
            payload: { psnTitleId: 'CUSA00552_00', psnNpCommunicationId: 'NPWR10388_00' },
            selected: true,
          }),
        ]}
      />,
    );

    expect(screen.getByText('Title CUSA00552_00 · Trophy NPWR10388_00')).toBeInTheDocument();
  });

  it('formats a platinum field update as Yes/No, not the raw boolean', () => {
    render(
      <SyncReview
        run={makeRun({ source: 'psn' })}
        changes={[
          makeChange({
            id: 'field-1',
            kind: 'field_update',
            title: 'Bloodborne',
            payload: { field: 'platinum', from: false, to: true },
            selected: true,
          }),
        ]}
      />,
    );

    expect(screen.getByText('Platinum')).toBeInTheDocument();
    expect(screen.getByText('No → Yes')).toBeInTheDocument();
  });

  it('formats a platform field update through PLATFORM_LABELS, not the raw enum value', () => {
    render(
      <SyncReview
        run={makeRun({ source: 'psn' })}
        changes={[
          makeChange({
            id: 'field-1',
            kind: 'field_update',
            title: 'Returnal',
            payload: { field: 'platform', from: 'ps4', to: 'ps5' },
            selected: true,
          }),
        ]}
      />,
    );

    expect(screen.getByText('PS4 → PS5')).toBeInTheDocument();
  });

  it("labels the field updates group with PlayStation's wording for a PSN run", () => {
    render(
      <SyncReview
        run={makeRun({ source: 'psn' })}
        changes={[
          makeChange({
            id: 'field-1',
            kind: 'field_update',
            title: 'Returnal',
            payload: { field: 'firstPlayedYear', from: 2022, to: 2023 },
            selected: true,
          }),
        ]}
      />,
    );

    expect(screen.getByText("PlayStation's numbers differ from what's stored.")).toBeInTheDocument();
  });
});
