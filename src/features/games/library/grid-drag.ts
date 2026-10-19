'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  type GridGeometry,
  edgeScrollSpeed,
  geometryFrom,
  shiftTransform,
  slotAt,
  slotOffset,
} from './grid-drag-math';

/**
 * Drag-to-reorder for the gallery, built for INSTANT and SMOOTH.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY NOT dnd-kit HERE. dnd-kit re-renders every sortable item through React
 * on every pointer move and re-measures them all at lift; with 181 cards that
 * was a 250ms stall on the press, another when the first card shifted, and
 * a card that trailed the pointer. The owner asked for no delay at all.
 *
 * WHAT THIS DOES INSTEAD. Nothing goes through React while a card is in
 * hand. The pressed card itself follows the pointer by an inline transform
 * written in a requestAnimationFrame loop; the slot under it is arithmetic
 * on the grid (`grid-drag-math.ts`), measured once at lift; when that slot
 * changes, only the cards between the hole and the target get a transform
 * — the rest keep none, so no layer is promoted that does not move. The
 * drop animates the card into its slot, then the order is committed in one
 * React update and the transforms are cleared in a layout effect before the
 * next paint, so nothing jumps.
 *
 * ACTIVATION. A mouse or pen lifts after 3px of movement — a click still
 * opens the panel. A touch lifts after a 150ms hold; a finger that moves
 * first is a scroll and never a drag. Once lifted, touchmove is cancelled so
 * the page stops scrolling under the finger. The keyboard lifts with Space,
 * moves with the arrows, drops with Space or Enter, cancels with Escape.
 *
 * Every DOM write lives in a module-level helper below, deliberately: the
 * React Compiler lint reads a write to an element reached through a ref
 * inside the component as a mutation of hook state, and it is right that
 * the component should not be doing that — the drag is not React state.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const LIFT_TRANSITION = 'transform 220ms cubic-bezier(0.2, 0, 0, 1)';
const DROP_SETTLE_MS = 230;
const MOUSE_THRESHOLD_PX = 3;
const TOUCH_HOLD_MS = 150;
const TOUCH_TOLERANCE_PX = 8;

type Elements = readonly (HTMLElement | null)[];

interface Active {
  from: number;
  to: number;
  geometry: GridGeometry;
  /** Page coordinates of the pointer when the card lifted. */
  startX: number;
  startY: number;
  /** Latest pointer, page coordinates. */
  pageX: number;
  pageY: number;
  clientY: number;
  pointerId: number | null;
  frame: number;
  keyboard: boolean;
}

interface Pending {
  index: number;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  pointerType: string;
  timer: number | null;
}

// ── DOM writes, outside the component ────────────────────────────────────────

function measure(elements: Elements, count: number): GridGeometry | null {
  const rects = elements.slice(0, count).map((el) => {
    const rect = el?.getBoundingClientRect();
    return rect
      ? {
          left: rect.left + window.scrollX,
          top: rect.top + window.scrollY,
          width: rect.width,
          height: rect.height,
        }
      : { left: 0, top: 0, width: 0, height: 0 };
  });
  return geometryFrom(rects);
}

function applyShifts(elements: Elements, state: Active): void {
  for (let index = 0; index < state.geometry.count; index += 1) {
    if (index === state.from) continue;
    const el = elements[index];
    if (!el) continue;
    const transform = shiftTransform(state.geometry, index, state.from, state.to);
    if (el.style.transform !== transform) el.style.transform = transform;
  }
}

function styleLifted(el: HTMLElement): void {
  el.style.transition = 'none';
  el.style.zIndex = '50';
  el.style.willChange = 'transform';
  el.style.boxShadow = '0 20px 40px -12px rgba(0, 0, 0, 0.45)';
  el.style.transform = 'translate3d(0, 0, 0) scale(1.03)';
}

function followPointer(el: HTMLElement, dx: number, dy: number): void {
  el.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(1.03)`;
}

/** Glide the held card to slot `to` (the keyboard's step, and the drop). */
function glideTo(el: HTMLElement, state: Active, to: number, held: boolean): void {
  const here = slotOffset(state.geometry, state.from);
  const there = slotOffset(state.geometry, to);
  const scale = held ? ' scale(1.03)' : '';
  el.style.transition = LIFT_TRANSITION;
  el.style.transform =
    to === state.from && !held
      ? ''
      : `translate3d(${there.x - here.x}px, ${there.y - here.y}px, 0)${scale}`;
  if (!held) el.style.boxShadow = '';
}

function clearLiftStyles(elements: Elements): void {
  for (const el of elements) {
    if (!el) continue;
    el.style.zIndex = '';
    el.style.willChange = '';
    el.style.boxShadow = '';
  }
}

/** After the order re-rendered: drop every transform with NO transition, then hand the transition back once painted. */
function clearAllTransforms(elements: Elements): void {
  for (const el of elements) {
    if (!el) continue;
    el.style.transition = 'none';
    el.style.transform = '';
    el.style.zIndex = '';
    el.style.boxShadow = '';
    el.style.willChange = '';
  }
  requestAnimationFrame(() => {
    for (const el of elements) if (el) el.style.transition = '';
  });
}

function frameStep(elements: Elements, state: Active): void {
  const speed = edgeScrollSpeed(state.clientY, window.innerHeight);
  if (speed !== 0) {
    window.scrollBy(0, speed);
    state.pageY += speed;
  }
  const dx = state.pageX - state.startX;
  const dy = state.pageY - state.startY;
  const el = elements[state.from];
  if (el) followPointer(el, dx, dy);
  const origin = slotOffset(state.geometry, state.from);
  const centreX = state.geometry.originX + origin.x + dx + state.geometry.width / 2;
  const centreY = state.geometry.originY + origin.y + dy + state.geometry.height / 2;
  const slot = slotAt(state.geometry, centreX, centreY);
  if (slot !== state.to) {
    state.to = slot;
    applyShifts(elements, state);
  }
}

function preventTouchScroll(event: TouchEvent): void {
  event.preventDefault();
}

// ── The hook ─────────────────────────────────────────────────────────────────

export interface GridDragItemProps {
  readonly onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
  readonly onClickCapture: (event: React.MouseEvent<HTMLElement>) => void;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  /**
   * The browser's OWN drag must never start: a few pixels of movement over a
   * cover image begins an HTML5 drag of the `<img>` (a ghost thumbnail) and
   * cancels the pointer events this engine runs on — found by the owner on
   * the first card with art ("it won't let me drag the tile if there is a
   * thumbnail"). `draggable={false}` plus a refused `dragstart` covers it.
   */
  readonly onDragStart: (event: React.DragEvent<HTMLElement>) => void;
  readonly draggable: false;
  readonly 'aria-roledescription': 'sortable';
  readonly 'aria-describedby': string;
}

export function useGridDrag({
  count,
  layoutKey,
  onDrop,
  labelOf,
}: {
  readonly count: number;
  /** Changes when the rendered order changes — the moment to clear the drag's transforms. */
  readonly layoutKey: unknown;
  readonly onDrop: (from: number, to: number) => void;
  readonly labelOf: (index: number) => string;
}): {
  readonly setItem: (index: number, element: HTMLElement | null) => void;
  readonly itemProps: readonly GridDragItemProps[];
  readonly announcement: string;
  readonly instructionsId: string;
} {
  const items = useRef<(HTMLElement | null)[]>([]);
  const active = useRef<Active | null>(null);
  const pending = useRef<Pending | null>(null);
  const clearOnNextLayout = useRef(false);
  const suppressClick = useRef(false);
  const callbacks = useRef({ onDrop, labelOf });
  useEffect(() => {
    callbacks.current = { onDrop, labelOf };
  }, [onDrop, labelOf]);
  const [announcement, setAnnouncement] = useState('');
  const instructionsId = 'library-drag-instructions';

  const setItem = useCallback((index: number, element: HTMLElement | null) => {
    items.current[index] = element;
  }, []);

  // After a drop the order re-renders; clear every inline transform BEFORE
  // the paint so the cards, now in their new DOM slots, do not slide again.
  useLayoutEffect(() => {
    if (!clearOnNextLayout.current) return;
    clearOnNextLayout.current = false;
    clearAllTransforms(items.current);
  }, [layoutKey]);

  const finish = useCallback((state: Active, commit: boolean) => {
    cancelAnimationFrame(state.frame);
    active.current = null;
    document.removeEventListener('touchmove', preventTouchScroll);
    const to = commit ? state.to : state.from;
    if (!commit) {
      state.to = state.from;
      applyShifts(items.current, state);
    }
    const lifted = items.current[state.from];
    if (lifted) glideTo(lifted, state, to, false);
    window.setTimeout(() => {
      if (commit && to !== state.from) {
        clearOnNextLayout.current = true;
        callbacks.current.onDrop(state.from, to);
      } else {
        clearLiftStyles(items.current);
      }
      setAnnouncement(
        commit && to !== state.from
          ? `${callbacks.current.labelOf(state.from)} moved to position ${to + 1} of ${state.geometry.count}.`
          : `${callbacks.current.labelOf(state.from)} put back.`,
      );
    }, DROP_SETTLE_MS);
  }, []);

  const lift = useCallback(
    (index: number, pageX: number, pageY: number, clientY: number, pointerId: number | null) => {
      const geometry = measure(items.current, count);
      if (geometry === null) return;
      const state: Active = {
        from: index,
        to: index,
        geometry,
        startX: pageX,
        startY: pageY,
        pageX,
        pageY,
        clientY,
        pointerId,
        frame: 0,
        keyboard: pointerId === null,
      };
      active.current = state;
      const lifted = items.current[index];
      if (lifted) styleLifted(lifted);
      document.addEventListener('touchmove', preventTouchScroll, { passive: false });
      setAnnouncement(
        `${callbacks.current.labelOf(index)} lifted, position ${index + 1} of ${geometry.count}.`,
      );
      if (pointerId === null) return;
      const loop = () => {
        if (active.current !== state) return;
        frameStep(items.current, state);
        state.frame = requestAnimationFrame(loop);
      };
      state.frame = requestAnimationFrame(loop);
    },
    [count],
  );

  const clearPending = useCallback(() => {
    const p = pending.current;
    if (p !== null && p.timer !== null) window.clearTimeout(p.timer);
    pending.current = null;
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const state = active.current;
      if (state === null || event.key !== 'Escape') return;
      event.preventDefault();
      finish(state, false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [finish]);

  const itemProps = useMemo<GridDragItemProps[]>(() => {
    const make = (index: number): GridDragItemProps => ({
      'aria-roledescription': 'sortable',
      'aria-describedby': instructionsId,
      draggable: false,
      onDragStart: (event) => event.preventDefault(),
      onPointerDown: (event) => {
        if (active.current !== null || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const p: Pending = {
          index,
          pointerId: event.pointerId,
          startClientX: event.clientX,
          startClientY: event.clientY,
          pointerType: event.pointerType,
          timer: null,
        };
        pending.current = p;
        if (event.pointerType === 'touch') {
          const { pageX, pageY, clientY, pointerId } = event;
          p.timer = window.setTimeout(() => {
            if (pending.current !== p) return;
            pending.current = null;
            suppressClick.current = true;
            lift(index, pageX, pageY, clientY, pointerId);
          }, TOUCH_HOLD_MS);
        }
      },
      onPointerMove: (event) => {
        const state = active.current;
        if (state !== null && state.pointerId === event.pointerId) {
          state.pageX = event.pageX;
          state.pageY = event.pageY;
          state.clientY = event.clientY;
          return;
        }
        const p = pending.current;
        if (p === null || p.pointerId !== event.pointerId) return;
        const moved = Math.hypot(event.clientX - p.startClientX, event.clientY - p.startClientY);
        if (p.pointerType === 'touch') {
          // A finger that moves before the hold is scrolling, not dragging.
          if (moved > TOUCH_TOLERANCE_PX) clearPending();
          return;
        }
        if (moved >= MOUSE_THRESHOLD_PX) {
          pending.current = null;
          suppressClick.current = true;
          lift(index, event.pageX, event.pageY, event.clientY, event.pointerId);
        }
      },
      onPointerUp: (event) => {
        const state = active.current;
        if (state !== null && state.pointerId === event.pointerId) {
          finish(state, true);
          return;
        }
        clearPending();
      },
      onPointerCancel: (event) => {
        const state = active.current;
        if (state !== null && state.pointerId === event.pointerId) finish(state, false);
        clearPending();
      },
      onClickCapture: (event) => {
        // The click that ends a drag must not open the panel.
        if (suppressClick.current) {
          suppressClick.current = false;
          event.preventDefault();
          event.stopPropagation();
        }
      },
      onKeyDown: (event) => {
        const state = active.current;
        if (state === null) {
          if (event.key === ' ') {
            event.preventDefault();
            lift(index, 0, 0, 0, null);
          }
          return;
        }
        if (!state.keyboard || state.from !== index) return;
        const { columns, count: total } = state.geometry;
        let next = state.to;
        if (event.key === 'ArrowRight') next = Math.min(state.to + 1, total - 1);
        else if (event.key === 'ArrowLeft') next = Math.max(state.to - 1, 0);
        else if (event.key === 'ArrowDown') next = Math.min(state.to + columns, total - 1);
        else if (event.key === 'ArrowUp') next = Math.max(state.to - columns, 0);
        else if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          finish(state, true);
          return;
        } else return;
        event.preventDefault();
        state.to = next;
        applyShifts(items.current, state);
        const el = items.current[state.from];
        if (el) glideTo(el, state, next, true);
        setAnnouncement(`${callbacks.current.labelOf(index)}, position ${next + 1} of ${total}.`);
      },
    });
    return Array.from({ length: count }, (_, index) => make(index));
  }, [clearPending, count, finish, lift]);

  return { setItem, itemProps, announcement, instructionsId };
}
