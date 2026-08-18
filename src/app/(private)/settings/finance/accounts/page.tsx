import type { Metadata } from 'next';

import { AccountsManager } from '@/features/finance/settings/accounts-manager';
import { requireOwner } from '@/server/auth/owner';
import { listAccounts } from '@/server/db/finance/accounts';

export const metadata: Metadata = { title: 'Accounts — Burmy' };

/**
 * Calls `requireOwner()` directly, not because the layout forgot to, but because
 * the owner id is what scopes the read. There is no way to call `listAccounts`
 * without one.
 */
export default async function AccountsPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();
  const accounts = await listAccounts(owner.userId);

  return <AccountsManager accounts={accounts} />;
}
