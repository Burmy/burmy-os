import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { GamesSyncSection } from '@/features/games/settings/games-sync-section';
import type { PsnTokenAge } from '@/server/games/psn-token-age';

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

    expect(screen.getByText('STEAM_API_KEY')).toBeInTheDocument();
    expect(screen.getByText('STEAM_ID')).toBeInTheDocument();
    expect(screen.getByText('PSN_NPSSO')).toBeInTheDocument();

    const link = screen.getByRole('link', { name: /ca\.account\.sony\.com/i });
    expect(link).toHaveAttribute('href', 'https://ca.account.sony.com/api/v1/ssocookie');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
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
    expect(screen.getByText(/token 12d old\./i)).toBeInTheDocument();
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
