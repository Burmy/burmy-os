import { describe, expect, it } from 'vitest';

import {
  GAME_PLATFORMS,
  GAME_STATUSES,
  PLATFORM_LABELS,
  PLATFORM_PICKER_OPTIONS,
  STATUS_LABELS,
} from '@/server/games/taxonomy';

describe('GAME_STATUSES', () => {
  it('is exactly the three visible states plus the invisible played default', () => {
    // Order matters for the library's filter-chip row, so this is an exact
    // match, not a `toContain` per value.
    expect(GAME_STATUSES).toEqual(['backlog', 'playing', 'played', 'wanted']);
  });

  it('no longer offers the old completed/paused_dropped values — real usage showed one status describing 95% of the library', () => {
    expect(GAME_STATUSES).not.toContain('completed');
    expect(GAME_STATUSES).not.toContain('paused_dropped');
  });
});

describe('STATUS_LABELS', () => {
  it('has a label for every reachable status, including the invisible played default', () => {
    for (const status of GAME_STATUSES) {
      expect(typeof STATUS_LABELS[status]).toBe('string');
      expect(STATUS_LABELS[status].length).toBeGreaterThan(0);
    }
  });

  it('labels played as "Played" — a real label still exists even though StatusBadge never shows it as a badge', () => {
    expect(STATUS_LABELS.played).toBe('Played');
  });
});

describe('PLATFORM_LABELS', () => {
  it('relabels steam as "Steam / PC", absorbing the unused pc category', () => {
    expect(PLATFORM_LABELS.steam).toBe('Steam / PC');
  });

  it('still labels a hypothetical pc row sensibly rather than leaving a Record lookup undefined', () => {
    // `pc` stays in the enum/type/label map even though the picker no longer
    // offers it — dropping a Postgres enum value needs a migration, and this
    // is what keeps `PLATFORM_LABELS[game.platform]` from ever rendering
    // `undefined` for a game already stored with `platform = 'pc'`.
    expect(PLATFORM_LABELS.pc).toBe('PC');
  });
});

describe('PLATFORM_PICKER_OPTIONS', () => {
  it('excludes pc — it would only duplicate "Steam / PC" for new entries', () => {
    expect(PLATFORM_PICKER_OPTIONS).not.toContain('pc');
  });

  it('is every other platform, unchanged', () => {
    expect(PLATFORM_PICKER_OPTIONS).toEqual(GAME_PLATFORMS.filter((platform) => platform !== 'pc'));
  });
});
