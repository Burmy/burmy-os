import { describe, expect, it } from 'vitest';

import { formatRarity, rarityToTenths, remainingCount, unlockTimeToIso } from '@/server/games/trophies';

/**
 * Rarity is an INTEGER of tenths of a percent, for the same reason money is an
 * integer of cents: CLAUDE.md forbids `NUMERIC` because the `pg` driver returns
 * it as a string and the `parseFloat` that follows is the exact bug this
 * project exists to avoid. These tests pin the boundary conversion.
 */
describe('rarityToTenths', () => {
  it('converts both sources one-decimal strings', () => {
    // PSN `trophyEarnedRate`, Steam `percent` — both arrive as strings.
    expect(rarityToTenths('22.5')).toBe(225);
    expect(rarityToTenths('76.8')).toBe(768);
    expect(rarityToTenths('0.4')).toBe(4);
  });

  it('accepts a number, since Steam has been seen to send one', () => {
    expect(rarityToTenths(76.8)).toBe(768);
  });

  it('handles both ends of the range exactly', () => {
    expect(rarityToTenths('0')).toBe(0);
    expect(rarityToTenths('100')).toBe(1000);
  });

  /**
   * `null`, not `0`. "The API did not report a rate" and "nobody on earth has
   * this trophy" are different facts, and 0 would claim the second — which
   * would also sort a trophy of unknown rarity to the very top of the "rarest
   * earned" list, ahead of genuinely rare ones.
   */
  it('returns null for anything that is not a real percentage, never zero', () => {
    expect(rarityToTenths(null)).toBeNull();
    expect(rarityToTenths(undefined)).toBeNull();
    // `Number('')` is 0, not NaN — the guard has to be explicit.
    expect(rarityToTenths('')).toBeNull();
    expect(rarityToTenths('   ')).toBeNull();
    expect(rarityToTenths('very rare')).toBeNull();
    expect(rarityToTenths(-1)).toBeNull();
    expect(rarityToTenths(101)).toBeNull();
    expect(rarityToTenths(Number.NaN)).toBeNull();
  });
});

describe('formatRarity', () => {
  it('round-trips a stored value back to one decimal place', () => {
    expect(formatRarity(225)).toBe('22.5%');
    expect(formatRarity(4)).toBe('0.4%');
    expect(formatRarity(1000)).toBe('100.0%');
  });

  it('passes null through rather than printing a fabricated 0%', () => {
    expect(formatRarity(null)).toBeNull();
  });
});

/**
 * Steam's `unlocktime` is Unix SECONDS with `0` meaning never unlocked — the
 * identical sentinel `rtime_last_played` uses. Reading it literally would date
 * every locked achievement to 1970 and flood "earned recently" with the entire
 * library, sorted by nothing.
 */
describe('unlockTimeToIso', () => {
  it('converts a real unlock time', () => {
    expect(unlockTimeToIso(1_735_010_079)).toBe('2024-12-24T03:14:39.000Z');
  });

  it('treats 0 as never unlocked, not as 1970', () => {
    expect(unlockTimeToIso(0)).toBeNull();
  });

  it('rejects negatives and non-numbers rather than inventing a date', () => {
    expect(unlockTimeToIso(-5)).toBeNull();
    expect(unlockTimeToIso('1735010079')).toBeNull();
    expect(unlockTimeToIso(null)).toBeNull();
    expect(unlockTimeToIso(Number.NaN)).toBeNull();
  });
});

describe('remainingCount', () => {
  it('reports how many are left', () => {
    expect(remainingCount(32, 35)).toBe(3);
    expect(remainingCount(35, 35)).toBe(0);
  });

  it('floors at zero rather than going negative on inconsistent input', () => {
    expect(remainingCount(40, 35)).toBe(0);
  });
});
