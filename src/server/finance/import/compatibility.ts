import type { AdapterId } from '@/server/finance/parse/types';

/**
 * Does the detected statement format belong on this account?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A BoA credit-card export staged against a checking account (or the reverse)
 * would parse cleanly — the parser has no idea which account the owner meant —
 * and every row would carry a plausible-looking wrong `account_id`. Nothing
 * downstream would notice: the dedupe key includes `accountId`, so it would
 * simply never collide with the real checking history and just sit there as
 * silently misfiled spending. Catching the mismatch before staging, while the
 * owner is still looking at the upload form, is far cheaper than finding it
 * later in the monthly grid.
 *
 * `AccountType` is NOT imported from `db/finance/accounts.ts` — this module is
 * `src/server/finance/`, which stays free of any dependency on `src/server/db/`,
 * even a type-only one. The four values are declared locally and mirror
 * `ACCOUNT_TYPES` there; `cash` is absent from both for the same reason (no
 * cash-producing statement exists).
 * ─────────────────────────────────────────────────────────────────────────────
 */
export type AccountType = 'checking' | 'savings' | 'credit_card' | 'brokerage';

const EXPECTED_ACCOUNT_TYPES: Record<AdapterId, readonly AccountType[]> = {
  'boa-deposit': ['checking', 'savings'],
  'boa-card': ['credit_card'],
  // Unreachable in practice — a generic-format file is rejected before this
  // check ever runs (no generic mapper exists yet, see M5 scope). Listed for
  // exhaustiveness, since `Record<AdapterId, ...>` requires every key.
  generic: [],
};

function describeAdapter(adapter: AdapterId): string {
  switch (adapter) {
    case 'boa-deposit':
      return 'a Bank of America checking or savings export';
    case 'boa-card':
      return 'a Bank of America credit card export';
    case 'generic':
      return 'an unrecognized statement format';
  }
}

function describeAccountType(type: AccountType): string {
  return type === 'credit_card' ? 'credit card' : type;
}

export class AccountFormatMismatchError extends Error {
  constructor(
    readonly adapter: AdapterId,
    readonly accountType: AccountType,
  ) {
    super(
      `This file looks like ${describeAdapter(adapter)}, but the selected account is a ` +
        `${describeAccountType(accountType)} account. Choose the matching account, or double-check the file.`,
    );
    this.name = 'AccountFormatMismatchError';
  }
}

export function isAccountCompatible(adapter: AdapterId, accountType: AccountType): boolean {
  return EXPECTED_ACCOUNT_TYPES[adapter].includes(accountType);
}

/** @throws AccountFormatMismatchError */
export function assertAccountCompatible(adapter: AdapterId, accountType: AccountType): void {
  if (!isAccountCompatible(adapter, accountType)) {
    throw new AccountFormatMismatchError(adapter, accountType);
  }
}
