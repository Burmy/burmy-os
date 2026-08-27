import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PsnTokenAge } from '@/server/games/psn-token-age';

// `GamesSyncSection` now renders the real `SyncButton`/`PsnSyncButton` (they
// moved here from the Library screen's top bar) — both call `useRouter()`
// and import their own server actions, so this file needs the same mocks
// `games-sync-button.test.tsx`/`games-psn-sync-button.test.tsx` already use,
// even though none of the tests below click a button.
vi.mock('@/features/games/sync/sync-actions', () => ({
  startSteamSyncAction: vi.fn(),
  advanceSteamSyncAction: vi.fn(),
  advanceSyncEnrichmentAction: vi.fn(),
}));

vi.mock('@/features/games/sync/psn-actions', () => ({
  startPsnSyncAction: vi.fn(),
  advancePsnSyncAction: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { GamesSyncSection } = await import('@/features/games/settings/games-sync-section');

function props(overrides: Partial<Parameters<typeof GamesSyncSection>[0]> = {}): Parameters<typeof GamesSyncSection>[0] {
  return {
    steamConfigured: false,
    steamLastSyncedAt: null,
    psnConfigured: false,
    psnLastSyncedAt: null,
    psnTokenAge: { status: 'unknown', ageDays: null },
    ...overrides,
  };
}

describe('GamesSyncSection — not configured', () => {
  it('names both required Steam vars and the PSN var, with a real clickable Sony link', () => {
    render(<GamesSyncSection {...props()} />);

    // Each var name now appears twice — once in this component's own
    // paragraph, once in the real SyncButton/PsnSyncButton's own
    // not-configured hint (both render for real here since the sync trigger
    // buttons moved into this section) — so these assert "at least one",
    // not exactly one.
    expect(screen.getAllByText('STEAM_API_KEY').length).toBeGreaterThan(0);
    expect(screen.getAllByText('STEAM_ID').length).toBeGreaterThan(0);
    expect(screen.getAllByText('PSN_NPSSO').length).toBeGreaterThan(0);

    const links = screen.getAllByRole('link', { name: /ca\.account\.sony\.com/i });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute('href', 'https://ca.account.sony.com/api/v1/ssocookie');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noreferrer');
    }
  });

  it('renders both sync buttons disabled when neither source is configured', () => {
    render(<GamesSyncSection {...props()} />);

    expect(screen.getByRole('button', { name: /sync with steam/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /sync with playstation/i })).toBeDisabled();
  });
});

describe('GamesSyncSection — sync buttons', () => {
  it('enables each sync button independently once its own source is configured', () => {
    render(<GamesSyncSection {...props({ steamConfigured: true, psnConfigured: false })} />);

    expect(screen.getByRole('button', { name: /sync with steam/i })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /sync with playstation/i })).toBeDisabled();
  });
});

describe('GamesSyncSection — configured', () => {
  it('shows connected + last-synced time for both sources, and a plain (non-warning) token age for PSN', () => {
    const tokenAge: PsnTokenAge = { status: 'normal', ageDays: 12 };

    render(
      <GamesSyncSection
        {...props({
          steamConfigured: true,
          steamLastSyncedAt: new Date(Date.now() - 60 * 60 * 1000),
          psnConfigured: true,
          psnLastSyncedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
          psnTokenAge: tokenAge,
        })}
      />,
    );

    expect(screen.getAllByText(/connected/i)).toHaveLength(2);
    expect(screen.getByText(/synced 1 hour ago/i)).toBeInTheDocument();
    expect(screen.getByText(/synced 3 days ago/i)).toBeInTheDocument();
    expect(screen.getByText(/token 12d old/i)).toBeInTheDocument();
    // The refresh link is present even in the healthy state, not only once the
    // token is old enough to warn. A healthy token still expires eventually,
    // and the owner should never have to hunt for where the page last
    // mentioned Sony.
    expect(screen.getByRole('link', { name: /ca\.account\.sony\.com/i })).toBeInTheDocument();
    expect(screen.queryByText(/may expire soon/i)).not.toBeInTheDocument();
  });

  it('states plainly that token age is unknown, rather than implying a fresh token, when never synced under the current token', () => {
    render(
      <GamesSyncSection
        {...props({
          psnConfigured: true,
          psnTokenAge: { status: 'unknown', ageDays: null },
        })}
      />,
    );

    expect(screen.getByText(/token age unknown/i)).toBeInTheDocument();
  });
});

describe('GamesSyncSection — token warning', () => {
  it('surfaces a visible warning, with the Sony refresh link, once the token is old enough that expiry could be near', () => {
    render(
      <GamesSyncSection
        {...props({
          psnConfigured: true,
          psnLastSyncedAt: new Date(Date.now() - 60 * 1000),
          psnTokenAge: { status: 'warning', ageDays: 52 },
        })}
      />,
    );

    expect(screen.getByText(/52d old — may expire soon/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /ca\.account\.sony\.com/i })).toBeInTheDocument();
  });
});
