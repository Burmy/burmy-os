import type { Metadata } from 'next';
import { Tag } from 'lucide-react';
import Link from 'next/link';

import { PageHeader } from '@/components/ui/page-header';
import { GamesSyncSection } from '@/features/games/settings/games-sync-section';
import { getPsnTokenAgeAction, isPsnConfiguredAction } from '@/features/games/sync/psn-actions';
import { getLastSyncedTimesAction, isSteamConfiguredAction } from '@/features/games/sync/sync-actions';
import { ThemeToggle } from '@/features/shell/theme-toggle';
import { requireOwner } from '@/server/auth/owner';
import { readTheme } from '@/server/security/theme';

export const metadata: Metadata = { title: 'Settings — Burmy' };

const FINANCE_LINKS = [
  { href: '/settings/finance/categories', label: 'Categories', description: 'Spending, income, and investment categories', Icon: Tag },
] as const;

/**
 * Settings belongs to Burmy-OS as a whole, not to Finance — this is why it is
 * a top-level destination in the sidebar rather than something reached
 * through Finance. Grouped by section (Finance, Games, General) rather than
 * one flat list, and General holds preferences that apply everywhere, not
 * to any one module — Theme today, currently also reachable from the
 * sidebar footer; both read/write the exact same cookie, so there is
 * nothing to keep in sync between them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE ROW CONVENTION, NOT TWO.
 *
 * This page used to wrap each row in `p-4`/`rounded-md border` while
 * `features/finance/settings/categories-manager.tsx` used `ul`/`li` with
 * `border-t border-b`/`py-2` — two visual languages one click apart. This
 * page now adopts CATEGORIES' convention (the one already proven on a
 * higher-traffic, daily-use Finance page) rather than the other way around,
 * so `categories-manager.tsx` needed no changes at all to bring the two into
 * line — the lower-risk direction, since Finance stays untouched.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export default async function SettingsPage(): Promise<React.ReactElement> {
  await requireOwner();
  const [theme, steamConfigured, psnConfigured, lastSyncedTimes, psnTokenAge] = await Promise.all([
    readTheme(),
    isSteamConfiguredAction(),
    isPsnConfiguredAction(),
    getLastSyncedTimesAction(),
    getPsnTokenAgeAction(),
  ]);

  return (
    <div>
      <PageHeader title="Settings" />

      <div className="mt-8">
        <h2 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">Finance</h2>
        <ul className="mt-3 divide-y border-t border-b">
          {FINANCE_LINKS.map(({ href, label, description, Icon }) => (
            <li key={href}>
              <Link href={href} className="hover:bg-muted/50 flex items-center gap-3 py-2 text-sm transition-colors">
                <Icon className="text-muted-foreground size-4 shrink-0" />
                <span className="flex-1">
                  <span className="font-medium">{label}</span>
                  <span className="text-muted-foreground block text-xs">{description}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-8">
        <h2 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">Games</h2>
        <h3 className="text-muted-foreground mt-3 text-xs font-medium">Sync</h3>
        <GamesSyncSection
          steamConfigured={steamConfigured}
          steamLastSyncedAt={lastSyncedTimes.steam}
          psnConfigured={psnConfigured}
          psnLastSyncedAt={lastSyncedTimes.psn}
          psnTokenAge={psnTokenAge}
        />
      </div>

      <div className="mt-8">
        <h2 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">General</h2>
        <ul className="mt-3 border-t border-b">
          <li className="flex items-center justify-between py-2 text-sm">
            <span>
              <span className="font-medium">Theme</span>
              <span className="text-muted-foreground block text-xs">Light, dark, or match your system</span>
            </span>
            <ThemeToggle current={theme} />
          </li>
        </ul>
      </div>
    </div>
  );
}
