import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const startAnimeSyncAction = vi.fn();
const advanceAnimeSyncAction = vi.fn();

vi.mock('@/features/anime/sync/sync-actions', () => ({
  startAnimeSyncAction: (...args: unknown[]) => startAnimeSyncAction(...args),
  advanceAnimeSyncAction: (...args: unknown[]) => advanceAnimeSyncAction(...args),
}));

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const toastError = vi.fn();
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: toastError } }));

const { AnimeSyncButton } = await import('@/features/anime/sync/sync-button');

describe('AnimeSyncButton', () => {
  // `restoreMocks` only restores `vi.spyOn` spies; call history and queued
  // `mockResolvedValueOnce` implementations on a plain `vi.fn()` have to be
  // reset by hand, and several tests below assert exact call counts.
  beforeEach(() => {
    startAnimeSyncAction.mockReset();
    advanceAnimeSyncAction.mockReset();
    push.mockClear();
    toastError.mockClear();
  });

  describe('with ANILIST_USERNAME unset', () => {
    it('renders disabled with the variable named, never hidden', () => {
      render(<AnimeSyncButton configured={false} />);

      expect(screen.getByRole('button', { name: /Sync with AniList/ })).toBeDisabled();
      expect(screen.getByText('ANILIST_USERNAME')).toBeInTheDocument();
    });

    it('never starts a run', async () => {
      const user = userEvent.setup();
      render(<AnimeSyncButton configured={false} />);

      await user.click(screen.getByRole('button', { name: /Sync with AniList/ }));

      expect(startAnimeSyncAction).not.toHaveBeenCalled();
    });
  });

  describe('the progress loop', () => {
    it('advances until a chunk comes back done, then opens the review screen', async () => {
      startAnimeSyncAction.mockResolvedValue({ ok: true, runId: 'run-1' });
      advanceAnimeSyncAction
        .mockResolvedValueOnce({ cursor: 50, total: 203, done: false })
        .mockResolvedValueOnce({ cursor: 100, total: 203, done: false })
        .mockResolvedValueOnce({ cursor: 100, total: 203, done: true });

      const user = userEvent.setup();
      render(<AnimeSyncButton configured />);
      await user.click(screen.getByRole('button', { name: /Sync with AniList/ }));

      await waitFor(() => expect(push).toHaveBeenCalledWith('/anime/sync/run-1'));
      expect(advanceAnimeSyncAction).toHaveBeenCalledTimes(3);
    });

    it('keeps going past cursor === total, because done is the only signal', async () => {
      // REGRESSION-shaped. `total` is counted once at run creation; a row added
      // mid-run means the cursor can sit at or beyond it with pages still to
      // walk. The Games engine reproduced both failure modes of the
      // `cursor >= total` comparison against real Postgres — putting it on the
      // client strands a run in exactly the same two places.
      startAnimeSyncAction.mockResolvedValue({ ok: true, runId: 'run-1' });
      advanceAnimeSyncAction
        .mockResolvedValueOnce({ cursor: 8, total: 8, done: false })
        .mockResolvedValueOnce({ cursor: 12, total: 8, done: false })
        .mockResolvedValueOnce({ cursor: 12, total: 8, done: true });

      const user = userEvent.setup();
      render(<AnimeSyncButton configured />);
      await user.click(screen.getByRole('button', { name: /Sync with AniList/ }));

      await waitFor(() => expect(push).toHaveBeenCalledWith('/anime/sync/run-1'));
      expect(advanceAnimeSyncAction).toHaveBeenCalledTimes(3);
    });

    it('reports a failed start and returns the button to idle', async () => {
      startAnimeSyncAction.mockResolvedValue({ ok: false, error: 'AniList did not respond.' });

      const user = userEvent.setup();
      render(<AnimeSyncButton configured />);
      await user.click(screen.getByRole('button', { name: /Sync with AniList/ }));

      await waitFor(() => expect(toastError).toHaveBeenCalledWith('AniList did not respond.'));
      expect(screen.getByRole('button', { name: /Sync with AniList/ })).toBeEnabled();
      expect(advanceAnimeSyncAction).not.toHaveBeenCalled();
    });

    it('stops on a mid-walk error rather than looping forever', async () => {
      startAnimeSyncAction.mockResolvedValue({ ok: true, runId: 'run-1' });
      advanceAnimeSyncAction
        .mockResolvedValueOnce({ cursor: 50, total: 203, done: false })
        .mockResolvedValueOnce({ error: 'That sync run no longer exists.' });

      const user = userEvent.setup();
      render(<AnimeSyncButton configured />);
      await user.click(screen.getByRole('button', { name: /Sync with AniList/ }));

      await waitFor(() => expect(toastError).toHaveBeenCalledWith('That sync run no longer exists.'));
      expect(push).not.toHaveBeenCalled();
    });
  });
});
