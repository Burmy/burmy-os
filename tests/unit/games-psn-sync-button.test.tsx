import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const startPsnSyncAction = vi.fn();
const advancePsnSyncAction = vi.fn();
// Same shared, source-agnostic enrichment phase `games-sync-button.test.tsx`
// mocks for Steam — `psn-sync-button.tsx` drives it too (see that
// component's own comment on its loop), defaulted here to "nothing to
// enrich, done immediately" so it never interferes with this file's
// existing sync-loop assertions.
const advanceSyncEnrichmentAction = vi.fn();

vi.mock('@/features/games/sync/psn-actions', () => ({
  startPsnSyncAction: (...args: unknown[]) => startPsnSyncAction(...args),
  advancePsnSyncAction: (...args: unknown[]) => advancePsnSyncAction(...args),
}));

vi.mock('@/features/games/sync/sync-actions', () => ({
  advanceSyncEnrichmentAction: (...args: unknown[]) => advanceSyncEnrichmentAction(...args),
}));

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const toastError = vi.fn();
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: toastError } }));

const { PsnSyncButton } = await import('@/features/games/sync/psn-sync-button');

describe('PsnSyncButton', () => {
  // Same reset discipline as `games-sync-button.test.tsx` — `restoreMocks`
  // only restores `vi.spyOn` spies, not a plain `vi.fn()`'s call history or
  // queued `mockResolvedValueOnce` implementations.
  beforeEach(() => {
    startPsnSyncAction.mockReset();
    advancePsnSyncAction.mockReset();
    advanceSyncEnrichmentAction.mockReset();
    advanceSyncEnrichmentAction.mockResolvedValue({ runId: 'psn-run-1', done: true, enrichedCount: 0 });
    push.mockClear();
    toastError.mockClear();
  });

  it('renders disabled with a visible explanation naming PSN_NPSSO when not configured', () => {
    render(<PsnSyncButton configured={false} />);

    const button = screen.getByRole('button', { name: /sync with playstation/i });
    expect(button).toBeDisabled();
    expect(screen.getByText('PSN_NPSSO')).toBeInTheDocument();
  });

  it('starts a run, drives progress to done, and navigates to the review screen', async () => {
    startPsnSyncAction.mockResolvedValue({ ok: true, runId: 'psn-run-1' });
    advancePsnSyncAction
      .mockResolvedValueOnce({ runId: 'psn-run-1', cursor: 5, total: 47, done: false, changeCount: 0 })
      .mockResolvedValueOnce({ runId: 'psn-run-1', cursor: 47, total: 47, done: true, changeCount: 3 });

    render(<PsnSyncButton configured={true} />);

    await userEvent.click(screen.getByRole('button', { name: /sync with playstation/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/games/sync/psn-run-1'));
    expect(advancePsnSyncAction).toHaveBeenCalledTimes(2);
  });

  it('shows "N of M games checked" progress while a run is in flight', async () => {
    startPsnSyncAction.mockResolvedValue({ ok: true, runId: 'psn-run-2' });
    let resolveSecondChunk: (value: unknown) => void = () => {};
    advancePsnSyncAction
      .mockResolvedValueOnce({ runId: 'psn-run-2', cursor: 24, total: 47, done: false, changeCount: 0 })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecondChunk = resolve;
          }),
      );

    render(<PsnSyncButton configured={true} />);

    await userEvent.click(screen.getByRole('button', { name: /sync with playstation/i }));

    await screen.findByText('24 of 47 games checked');

    resolveSecondChunk({ runId: 'psn-run-2', cursor: 47, total: 47, done: true, changeCount: 0 });
    await waitFor(() => expect(push).toHaveBeenCalledWith('/games/sync/psn-run-2'));
  });

  it('runs the enrichment phase after sync reaches done, showing "Adding cover art…", before navigating', async () => {
    startPsnSyncAction.mockResolvedValue({ ok: true, runId: 'psn-run-4' });
    advancePsnSyncAction.mockResolvedValueOnce({ runId: 'psn-run-4', cursor: 1, total: 1, done: true, changeCount: 1 });
    let resolveEnrichment: (value: unknown) => void = () => {};
    advanceSyncEnrichmentAction.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveEnrichment = resolve;
        }),
    );

    render(<PsnSyncButton configured={true} />);

    await userEvent.click(screen.getByRole('button', { name: /sync with playstation/i }));

    await screen.findByText('Adding cover art…');
    expect(push).not.toHaveBeenCalled();

    resolveEnrichment({ runId: 'psn-run-4', done: true, enrichedCount: 1 });
    await waitFor(() => expect(push).toHaveBeenCalledWith('/games/sync/psn-run-4'));
  });

  it('stops the loop and surfaces the message when an advance call errors', async () => {
    startPsnSyncAction.mockResolvedValue({ ok: true, runId: 'psn-run-3' });
    advancePsnSyncAction.mockResolvedValueOnce({ error: 'Sync run not found, or not running.' });

    render(<PsnSyncButton configured={true} />);

    await userEvent.click(screen.getByRole('button', { name: /sync with playstation/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Sync run not found, or not running.'));
    expect(push).not.toHaveBeenCalled();
    // Re-enabled rather than stuck spinning forever.
    expect(screen.getByRole('button', { name: /sync with playstation/i })).not.toBeDisabled();
  });

  // The three failure kinds `psn-client.ts` distinguishes
  // (`'not_configured' | 'token_expired' | 'unavailable'`) all surface here
  // as a `startPsnSyncAction` failure — the whole point being that each
  // reads differently, never one generic blob. This button doesn't branch
  // on which one it was; it just has to relay whatever distinct message
  // `startPsnSyncAction` produced, faithfully and without rewriting it.
  it('surfaces the distinct token-expired message, naming the retrieval URL, without ever calling advance', async () => {
    startPsnSyncAction.mockResolvedValue({
      ok: false,
      error:
        'Your PlayStation token expired (this happens roughly every two months) — get a new one from ' +
        'https://ca.account.sony.com/api/v1/ssocookie while logged in to PlayStation, then set PSN_NPSSO.',
    });

    render(<PsnSyncButton configured={true} />);

    await userEvent.click(screen.getByRole('button', { name: /sync with playstation/i }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringContaining('ca.account.sony.com/api/v1/ssocookie')),
    );
    expect(advancePsnSyncAction).not.toHaveBeenCalled();
  });

  it('surfaces the distinct "did not respond" message for an unavailable failure', async () => {
    startPsnSyncAction.mockResolvedValue({ ok: false, error: 'PlayStation did not respond. Try again in a moment.' });

    render(<PsnSyncButton configured={true} />);

    await userEvent.click(screen.getByRole('button', { name: /sync with playstation/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('PlayStation did not respond. Try again in a moment.'));
    expect(advancePsnSyncAction).not.toHaveBeenCalled();
  });

  it('renders a real, new-tab link to the Sony token-retrieval URL when not configured', () => {
    render(<PsnSyncButton configured={false} />);

    const link = screen.getByRole('link', { name: /ca\.account\.sony\.com/i });
    expect(link).toHaveAttribute('href', 'https://ca.account.sony.com/api/v1/ssocookie');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('switches to a persistent expired notice — with the same clickable link — on a token_expired failure, instead of only a toast', async () => {
    startPsnSyncAction.mockResolvedValue({
      ok: false,
      reason: 'token_expired',
      error:
        'Your PlayStation token expired (this happens roughly every two months) — get a new one from ' +
        'https://ca.account.sony.com/api/v1/ssocookie while logged in to PlayStation, then set PSN_NPSSO.',
    });

    render(<PsnSyncButton configured={true} />);

    await userEvent.click(screen.getByRole('button', { name: /sync with playstation/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());

    const link = await screen.findByRole('link', { name: /ca\.account\.sony\.com/i });
    expect(link).toHaveAttribute('href', 'https://ca.account.sony.com/api/v1/ssocookie');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('button', { name: /sync with playstation/i })).toBeDisabled();
  });

  it('does not switch to the expired notice for a non-token_expired failure reason', async () => {
    startPsnSyncAction.mockResolvedValue({
      ok: false,
      reason: 'unavailable',
      error: 'PlayStation did not respond. Try again in a moment.',
    });

    render(<PsnSyncButton configured={true} />);

    await userEvent.click(screen.getByRole('button', { name: /sync with playstation/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /ca\.account\.sony\.com/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sync with playstation/i })).not.toBeDisabled();
  });

  // The combined "Synced … · token …d old" caption, and the token-age
  // unknown/warning states, moved to Settings → Games → Sync
  // (`games-sync-section.test.tsx`) now that this button is a clean
  // single-line control — see `psn-sync-button.tsx`'s own doc comment.
  it('renders as a single control with no synced/token caption in the configured, idle state', () => {
    render(<PsnSyncButton configured={true} />);

    expect(screen.queryByText(/synced/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/token/i)).not.toBeInTheDocument();
  });
});
