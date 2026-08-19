import type { AdapterId } from '@/server/finance/parse/types';

/**
 * Which account type a detected statement format implies.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Account choice used to be something the owner picked, and a mismatch (a card
 * export staged against a checking account) needed catching before it silently
 * misfiled a month of spending under the wrong `account_id` — see this file's
 * git history for that version. Account management is gone now (round-2 UX
 * pass): the owner never sees or picks an account at all, so there is nothing
 * left to mismatch. This just answers "which of the two hidden accounts does
 * this format belong to" for `resolveHiddenAccount()`
 * (`db/finance/accounts.ts`) to route an upload to automatically.
 *
 * `boa-deposit` always resolves to `checking`, never `savings` — there is one
 * hidden checking-type account, not one per sub-type, and no real BoA export
 * shape needs the distinction in practice.
 *
 * `AccountType` is NOT imported from `db/finance/accounts.ts` — this module is
 * `src/server/finance/`, which stays free of any dependency on `src/server/db/`,
 * even a type-only one. The values are declared locally and mirror the two
 * hidden-account types `resolveHiddenAccount()` ever creates.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export type HiddenAccountType = 'checking' | 'credit_card';

export function defaultAccountTypeFor(adapter: Exclude<AdapterId, 'generic'>): HiddenAccountType {
  return adapter === 'boa-card' ? 'credit_card' : 'checking';
}
