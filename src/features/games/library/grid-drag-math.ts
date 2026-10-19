/**
 * The arithmetic behind the gallery's drag — pure, no DOM, unit-tested.
 *
 * The gallery is a UNIFORM grid: every card is the same size and the gaps
 * are constant, so a slot's position is a formula of its index and the
 * slot under a point is a formula of the point. That is what lets the drag
 * run with no measuring and no React work per move (`grid-drag.ts`).
 */

export interface GridGeometry {
  /** Page-coordinate origin of slot 0 (its top-left corner). */
  readonly originX: number;
  readonly originY: number;
  readonly width: number;
  readonly height: number;
  readonly gapX: number;
  readonly gapY: number;
  readonly columns: number;
  readonly count: number;
}

/** Top-left of slot `index`, relative to the origin. */
export function slotOffset(
  geometry: GridGeometry,
  index: number,
): { readonly x: number; readonly y: number } {
  const column = index % geometry.columns;
  const row = Math.floor(index / geometry.columns);
  return {
    x: column * (geometry.width + geometry.gapX),
    y: row * (geometry.height + geometry.gapY),
  };
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

/**
 * The slot whose cell contains the point (page coordinates) — the CENTRE of
 * the lifted card is what gets passed, so the card lands where most of it
 * is, not where the finger happens to be. Clamped to the grid, so dragging
 * off the edge targets the nearest edge slot rather than nothing.
 */
export function slotAt(geometry: GridGeometry, pageX: number, pageY: number): number {
  const rows = Math.ceil(geometry.count / geometry.columns);
  const column = clamp(
    Math.floor((pageX - geometry.originX + geometry.gapX / 2) / (geometry.width + geometry.gapX)),
    0,
    geometry.columns - 1,
  );
  const row = clamp(
    Math.floor((pageY - geometry.originY + geometry.gapY / 2) / (geometry.height + geometry.gapY)),
    0,
    Math.max(rows - 1, 0),
  );
  return clamp(row * geometry.columns + column, 0, Math.max(geometry.count - 1, 0));
}

/**
 * Where item `index` sits while `from` is being held over `to`: the items
 * between them step one slot towards the hole. Everything else stays.
 */
export function displacedIndex(index: number, from: number, to: number): number {
  if (index === from) return to;
  if (from < to && index > from && index <= to) return index - 1;
  if (to < from && index >= to && index < from) return index + 1;
  return index;
}

/** The CSS transform that moves item `index` to where it should sit, or `''` when it stays. */
export function shiftTransform(
  geometry: GridGeometry,
  index: number,
  from: number,
  to: number,
): string {
  const target = displacedIndex(index, from, to);
  if (target === index) return '';
  const here = slotOffset(geometry, index);
  const there = slotOffset(geometry, target);
  return `translate3d(${there.x - here.x}px, ${there.y - here.y}px, 0)`;
}

/**
 * Derives the geometry from the measured slots: the first card's size, the
 * gap to its neighbour, the first row's length. One measurement at lift,
 * then arithmetic. Rects are page-relative (viewport rect + scroll).
 */
export function geometryFrom(
  rects: readonly {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  }[],
): GridGeometry | null {
  const first = rects[0];
  if (first === undefined) return null;
  let columns = 1;
  while (columns < rects.length && Math.abs((rects[columns]?.top ?? 0) - first.top) < 1) {
    columns += 1;
  }
  const second = rects[1];
  const below = rects[columns];
  return {
    originX: first.left,
    originY: first.top,
    width: first.width,
    height: first.height,
    gapX: second !== undefined && columns > 1 ? second.left - (first.left + first.width) : 0,
    gapY: below !== undefined ? below.top - (first.top + first.height) : 0,
    columns,
    count: rects.length,
  };
}

/** Auto-scroll speed near the viewport's top or bottom edge: 0 in the middle, up to `max` px per frame at the edge. */
export function edgeScrollSpeed(
  clientY: number,
  viewportHeight: number,
  edge = 72,
  max = 14,
): number {
  if (clientY < edge) return -max * (1 - Math.max(clientY, 0) / edge);
  const fromBottom = viewportHeight - clientY;
  if (fromBottom < edge) return max * (1 - Math.max(fromBottom, 0) / edge);
  return 0;
}
