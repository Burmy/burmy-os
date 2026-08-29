import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/features/anime/sync/sync-actions', () => ({
  startAnimeSyncAction: vi.fn(),
  advanceAnimeSyncAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { AnimeSyncSection } = await import('@/features/anime/settings/anime-sync-section');

describe('AnimeSyncSection', () => {
  it('names the variable when AniList is not configured', () => {
    render(<AnimeSyncSection configured={false} lastSyncedAt={null} />);

    expect(screen.getByText(/Not connected/)).toBeInTheDocument();
    // Named twice by design — once in the row's explanation and once beside
    // the disabled button — so neither reading position leaves the owner
    // guessing why sync does nothing.
    expect(screen.getAllByText('ANILIST_USERNAME').length).toBeGreaterThan(0);
  });

  it('distinguishes connected-but-never-synced from connected-and-synced', () => {
    const { rerender } = render(<AnimeSyncSection configured lastSyncedAt={null} />);
    expect(screen.getByText(/not yet synced/)).toBeInTheDocument();

    rerender(<AnimeSyncSection configured lastSyncedAt={new Date(Date.now() - 3 * 86_400_000)} />);
    expect(screen.getByText(/Synced 3 days ago/)).toBeInTheDocument();
  });

  it('offers exactly one source — there is no second anime provider', () => {
    render(<AnimeSyncSection configured lastSyncedAt={null} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });
});
