import type { Metadata } from 'next';
import { asc, eq } from 'drizzle-orm';

import { PasskeysManager } from '@/features/finance/settings/passkeys-manager';
import { MIN_PASSKEYS, requireOwner } from '@/server/auth/owner';
import { getDb } from '@/server/db';
import { passkey as passkeyTable } from '@/server/db/schema';

export const metadata: Metadata = { title: 'Passkeys — Burmy' };

/**
 * Read directly rather than through `src/server/db/finance/`.
 *
 * That directory is the FINANCE data-access layer; passkeys are auth data, and
 * putting them there would blur a boundary the plan is explicit about. The select
 * below is still owner-scoped, and it deliberately does not select `publicKey` or
 * `credentialID` — neither is secret, but neither belongs in a page payload.
 */
export default async function PasskeysPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();

  const rows = await getDb()
    .select({
      id: passkeyTable.id,
      name: passkeyTable.name,
      createdAt: passkeyTable.createdAt,
    })
    .from(passkeyTable)
    .where(eq(passkeyTable.userId, owner.userId))
    .orderBy(asc(passkeyTable.createdAt));

  return (
    <PasskeysManager
      minimum={MIN_PASSKEYS}
      passkeys={rows.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.createdAt ? row.createdAt.toISOString() : null,
      }))}
    />
  );
}
