import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const startSteamSyncAction = vi.fn();
const advanceSteamSyncAction = vi.fn();

vi.mock('@/features/games/sync/sync-actions', () => ({
  startSteamSyncAction: (...args: unknown[]) => startSteamSyncAction(...args),
  advanceSteamSyncAction: (...args: unknown[]) => advanceSteamSyncAction(...args),
}));

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const toastError = vi.fn();
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: toastError } }));

const { SyncButton } = await import('@/features/games/sync/sync-button');

describe('SyncButton', () => {
  // `restoreMocks` in vitest.config only restores spies created via
  // `vi.spyOn` — it does not clear call history or queued
  // `mockResolvedValueOnce` implementations on a plain `vi.fn()`. Several
  // tests below assert exact call counts / "not called", so state has to be
  // reset explicitly between them.
  beforeEach(() => {
    startSteamSyncAction.mockReset();
    advanceSteamSyncAction.mockReset();
    push.mockClear();
    toastError.mockClear();
  });

  it('renders disabled with a visible explanation naming both env vars when Steam is not configured', () => {
    render(<SyncButton configured={false} />);

    const button = screen.getByRole('button', { name: /sync with steam/i });
    expect(button).toBeDisabled();
    expect(screen.getByText('STEAM_API_KEY')).toBeInTheDocument();
    expect(screen.getByText('STEAM_ID')).toBeInTheDocument();
  });

  it('starts a run, drives progress to done, and navigates to the review screen', async () => {
    startSteamSyncAction.mockResolvedValue({ ok: true, runId: 'run-1' });
    advanceSteamSyncAction
      .mockResolvedValueOnce({ runId: 'run-1', cursor: 5, total: 47, done: false, changeCount: 0 })
      .mockResolvedValueOnce({ runId: 'run-1', cursor: 47, total: 47, done: true, changeCount: 3 });

    render(<SyncButton configured={true} />);

    await userEvent.click(screen.getByRole('button', { name: /sync with steam/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/games/sync/run-1'));
    expect(advanceSteamSyncAction).toHaveBeenCalledTimes(2);
  });

  it('shows "N of M games checked" progress while a run is in flight', async () => {
    startSteamSyncAction.mockResolvedValue({ ok: true, runId: 'run-2' });
    let resolveSecondChunk: (value: unknown) => void = () => {};
    advanceSteamSyncAction
      .mockResolvedValueOnce({ runId: 'run-2', cursor: 24, total: 47, done: false, changeCount: 0 })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecondChunk = resolve;
          }),
      );

    render(<SyncButton configured={true} />);

    await userEvent.click(screen.getByRole('button', { name: /sync with steam/i }));

    await screen.findByText('24 of 47 games checked');

    resolveSecondChunk({ runId: 'run-2', cursor: 47, total: 47, done: true, changeCount: 0 });
    await waitFor(() => expect(push).toHaveBeenCalledWith('/games/sync/run-2'));
  });

  it('stops the loop and surfaces the message when an advance call errors', async () => {
    startSteamSyncAction.mockResolvedValue({ ok: true, runId: 'run-3' });
    advanceSteamSyncAction.mockResolvedValueOnce({ error: 'Sync run not found, or not running.' });

    render(<SyncButton configured={true} />);

    await userEvent.click(screen.getByRole('button', { name: /sync with steam/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Sync run not found, or not running.'));
    expect(push).not.toHaveBeenCalled();
    // Re-enabled rather than stuck spinning forever.
    expect(screen.getByRole('button', { name: /sync with steam/i })).not.toBeDisabled();
  });

  it('surfaces a failed start without ever calling advance', async () => {
    startSteamSyncAction.mockResolvedValue({ ok: false, error: 'Steam did not respond. Try again in a moment.' });

    render(<SyncButton configured={true} />);

    await userEvent.click(screen.getByRole('button', { name: /sync with steam/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Steam did not respond. Try again in a moment.'));
    expect(advanceSteamSyncAction).not.toHaveBeenCalled();
  });

  it('shows a "Synced …" line when a last-successful-sync time is provided', () => {
    render(<SyncButton configured={true} lastSyncedAt={new Date(Date.now() - 60_000)} />);

    expect(screen.getByText(/synced 1 minute ago/i)).toBeInTheDocument();
  });

  it('renders no synced line at all when the source has never synced', () => {
    render(<SyncButton configured={true} lastSyncedAt={null} />);

    expect(screen.queryByText(/synced/i)).not.toBeInTheDocument();
  });
});
