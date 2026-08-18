import type { Metadata } from 'next';
import { CreditCard, Tag } from 'lucide-react';
import Link from 'next/link';

import { requireOwner } from '@/server/auth/owner';

export const metadata: Metadata = { title: 'Settings — Burmy' };

const FINANCE_LINKS = [
  { href: '/settings/finance/accounts', label: 'Accounts', description: 'Checking, savings, cards, brokerage', Icon: CreditCard },
  { href: '/settings/finance/categories', label: 'Categories', description: 'Spending, income, and investment categories', Icon: Tag },
] as const;

/**
 * Settings belongs to Burmy-OS as a whole, not to Finance — this is why it is
 * a top-level destination in the sidebar rather than something reached
 * through Finance. Today Finance is the only group with anything to
 * configure, so it is the only one shown. No placeholder "General" section:
 * CLAUDE.md is explicit that Burmy does not build ahead of a real need, and
 * an empty settings group is exactly that.
 *
 * Calls `requireOwner()` like every other private page, even though this one
 * renders no owner-scoped data — the value of the rule is that it has no
 * exceptions to reason about (see the identical justification in
 * `theme-actions.ts`).
 */
export default async function SettingsPage(): Promise<React.ReactElement> {
  await requireOwner();

  return (
    <div>
      <h1 className="text-xl font-semibold">Settings</h1>

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
    </div>
  );
}
