import { describe, expect, it } from 'vitest';

import { TOOLTIP_STYLES, categoryColor } from '@/components/ui/chart-utils';

describe('categoryColor', () => {
  it('cycles through the palette rather than running out', () => {
    expect(categoryColor(0)).toBe(categoryColor(16));
    expect(categoryColor(0)).not.toBe(categoryColor(1));
  });
});

describe('TOOLTIP_STYLES', () => {
  it('disables the default hover cursor — Recharts renders an opaque full-height rectangle otherwise', () => {
    expect(TOOLTIP_STYLES.cursor).toBe(false);
  });
});
