import { describe, expect, it } from 'vitest';

import { GAME_PLATFORMS, PLATFORM_LABELS, PLATFORM_PICKER_OPTIONS } from '@/server/games/taxonomy';

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
