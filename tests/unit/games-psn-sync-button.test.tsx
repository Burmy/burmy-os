import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const startPsnSyncAction = vi.fn();
const advancePsnSyncAction = vi.fn();

vi.mock('@/features/games/sync/psn-actions', () => ({
  startPsnSyncAction: (...args: unknown[]) => startPsnSyncAction(...args),
  advancePsnSyncAction: (...args: unknown[]) => advancePsnSyncAction(...args),
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
});
