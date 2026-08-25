import type { Metadata } from 'next';
import { Tag } from 'lucide-react';
import Link from 'next/link';

import { PageHeader } from '@/components/ui/page-header';
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
 * through Finance. Grouped by section (Finance today; more sections land
 * here as more of the app grows, without needing a redesign) rather than
 * one flat list, and General holds preferences that apply everywhere, not
 * to any one module — Theme today, currently also reachable from the
 * sidebar footer; both read/write the exact same cookie, so there is
 * nothing to keep in sync between them.
 */
export default async function SettingsPage(): Promise<React.ReactElement> {
  await requireOwner();
  const theme = await readTheme();

  return (
    <div>
      <PageHeader title="Settings" />

      <div className="mt-8">
        <h2 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">Finance</h2>
        <div className="mt-3 divide-y rounded-md border">
          {FINANCE_LINKS.map(({ href, label, description, Icon }) => (
            <Link
              key={href}
              href={href}
              className="hover:bg-muted/50 flex items-center gap-3 p-4 text-sm transition-colors"
            >
              <Icon className="text-muted-foreground size-4 shrink-0" />
              <span className="flex-1">
                <span className="font-medium">{label}</span>
                <span className="text-muted-foreground block text-xs">{description}</span>
              </span>
            </Link>
          ))}
        </div>
      </div>

      <div className="mt-8">
        <h2 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">General</h2>
        <div className="mt-3 flex items-center justify-between rounded-md border p-4 text-sm">
          <span>
            <span className="font-medium">Theme</span>
            <span className="text-muted-foreground block text-xs">Light, dark, or match your system</span>
          </span>
          <ThemeToggle current={theme} />
        </div>
      </div>
    </div>
  );
}
