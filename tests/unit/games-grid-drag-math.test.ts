import { describe, expect, it } from 'vitest';

import {
  type GridGeometry,
  displacedIndex,
  edgeScrollSpeed,
  geometryFrom,
  shiftTransform,
  slotAt,
  slotOffset,
} from '@/features/games/library/grid-drag-math';

/** A 4-column grid of 200×260 cards with 24px gaps, 10 cards, origin (100, 300). */
const grid: GridGeometry = {
  originX: 100,
  originY: 300,
  width: 200,
  height: 260,
  gapX: 24,
  gapY: 24,
  columns: 4,
  count: 10,
};

describe('slotOffset', () => {
  it('walks columns then rows', () => {
    expect(slotOffset(grid, 0)).toEqual({ x: 0, y: 0 });
    expect(slotOffset(grid, 3)).toEqual({ x: 672, y: 0 });
    expect(slotOffset(grid, 4)).toEqual({ x: 0, y: 284 });
    expect(slotOffset(grid, 9)).toEqual({ x: 224, y: 568 });
  });
});

describe('slotAt', () => {
  it('finds the slot under a point, gap included, and clamps to the grid', () => {
    expect(slotAt(grid, 100, 300)).toBe(0);
    expect(slotAt(grid, 100 + 224 + 100, 300 + 130)).toBe(1);
    // In the gap between columns 1 and 2: the nearer half wins.
    expect(slotAt(grid, 100 + 224 + 200 + 5, 300)).toBe(1);
    expect(slotAt(grid, 100 + 224 + 200 + 20, 300)).toBe(2);
    expect(slotAt(grid, 100 + 224 * 2, 300 + 284)).toBe(6);
    // Off the right edge and below the last row: the nearest edge slot.
    expect(slotAt(grid, 5000, 300)).toBe(3);
    expect(slotAt(grid, 5000, 5000)).toBe(9);
    expect(slotAt(grid, -500, -500)).toBe(0);
  });
});

describe('displacedIndex and shiftTransform', () => {
  it('steps the items between the hole and the target one slot towards the hole', () => {
    // 1 held over 5: 2..5 step back one.
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => displacedIndex(i, 1, 5))).toEqual([0, 5, 1, 2, 3, 4, 6]);
    // 5 held over 1: 1..4 step forward one.
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => displacedIndex(i, 5, 1))).toEqual([0, 2, 3, 4, 5, 1, 6]);
  });

  it('writes a transform only for a card that moves, wrapping across rows', () => {
    expect(shiftTransform(grid, 0, 1, 5)).toBe('');
    expect(shiftTransform(grid, 2, 1, 5)).toBe('translate3d(-224px, 0px, 0)');
    // Index 4 (row 1, column 0) steps back to index 3 (row 0, column 3).
    expect(shiftTransform(grid, 4, 1, 5)).toBe('translate3d(672px, -284px, 0)');
    expect(shiftTransform(grid, 6, 1, 5)).toBe('');
  });
});

describe('geometryFrom', () => {
  it('derives size, gaps and column count from the measured rects', () => {
    const rects = Array.from({ length: 10 }, (_, i) => ({
      left: 100 + (i % 4) * 224,
      top: 300 + Math.floor(i / 4) * 284,
      width: 200,
      height: 260,
    }));
    expect(geometryFrom(rects)).toEqual(grid);
  });

  it('handles a single column and a single row', () => {
    expect(
      geometryFrom([
        { left: 0, top: 0, width: 50, height: 60 },
        { left: 0, top: 70, width: 50, height: 60 },
      ]),
    ).toMatchObject({ columns: 1, gapX: 0, gapY: 10 });
    expect(
      geometryFrom([
        { left: 0, top: 0, width: 50, height: 60 },
        { left: 58, top: 0, width: 50, height: 60 },
      ]),
    ).toMatchObject({ columns: 2, gapX: 8, gapY: 0 });
    expect(geometryFrom([])).toBeNull();
  });
});

describe('edgeScrollSpeed', () => {
  it('is zero in the middle and ramps towards the edges', () => {
    expect(edgeScrollSpeed(450, 900)).toBe(0);
    expect(edgeScrollSpeed(0, 900)).toBe(-14);
    expect(edgeScrollSpeed(900, 900)).toBe(14);
    expect(edgeScrollSpeed(36, 900)).toBeCloseTo(-7);
    expect(edgeScrollSpeed(900 - 36, 900)).toBeCloseTo(7);
  });
});
