import { describe, expect, it } from 'vitest';

import {
  PSN_TOKEN_WARNING_THRESHOLD_DAYS,
  psnTokenAge,
} from '@/server/games/psn-token-age';

/**
 * Pure age/threshold classification — no database, no clock dependency
 * (`now` is always pinned). Mirrors `hours.test.ts`'s discipline for a
 * different pure module in the same domain.
 */
describe('psnTokenAge', () => {
  const now = new Date('2026-08-25T00:00:00.000Z');

  it('is unknown with a null ageDays when the token has never successfully synced', () => {
    expect(psnTokenAge(null, now)).toEqual({ status: 'unknown', ageDays: null });
  });

  it('is normal for a token in use for a handful of days', () => {
    const inUseSince = new Date('2026-08-20T00:00:00.000Z'); // 5 days ago
    expect(psnTokenAge(inUseSince, now)).toEqual({ status: 'normal', ageDays: 5 });
  });

  it('is normal at exactly one day under the warning threshold', () => {
    const days = PSN_TOKEN_WARNING_THRESHOLD_DAYS - 1;
    const inUseSince = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    expect(psnTokenAge(inUseSince, now)).toEqual({ status: 'normal', ageDays: days });
  });

  it('is warning at exactly the threshold — the boundary is inclusive', () => {
    const days = PSN_TOKEN_WARNING_THRESHOLD_DAYS;
    const inUseSince = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    expect(psnTokenAge(inUseSince, now)).toEqual({ status: 'warning', ageDays: days });
  });

  it('stays warning well past the threshold, e.g. near the ~60-day approximate lifetime', () => {
    const inUseSince = new Date(now.getTime() - 61 * 24 * 60 * 60 * 1000);
    expect(psnTokenAge(inUseSince, now)).toEqual({ status: 'warning', ageDays: 61 });
  });

  it('clamps a future inUseSince (clock skew) to zero rather than a negative age', () => {
    const inUseSince = new Date(now.getTime() + 60_000);
    expect(psnTokenAge(inUseSince, now)).toEqual({ status: 'normal', ageDays: 0 });
  });

  it('reports zero days old for a token that started syncing today', () => {
    const inUseSince = new Date(now.getTime() - 60_000); // one minute ago
    expect(psnTokenAge(inUseSince, now)).toEqual({ status: 'normal', ageDays: 0 });
  });
});
