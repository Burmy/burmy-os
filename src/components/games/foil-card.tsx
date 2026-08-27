'use client';

import { useRef } from 'react';

import { cn } from '@/lib/utils';

/** How far the card tilts at the very edge of its own box. */
const MAX_TILT_DEG = 9;

export type FoilTone = 'platinum' | 'wishlist' | null;

/**
 * The library grid's hover treatment — a pointer-tracked glare plus, for
 * platinum and wishlist, a foil layer over the box art, on a 3D tilt.
 *
 * Technique ported from simeydotme/pokemon-cards-css (read from its actual
 * source, `public/css/cards/base.css` and `regular-holo.css`). All the visual
 * work lives in `globals.css` under `@layer components`; this component only
 * converts pointer position into the custom properties those rules read. See
 * that block for what each layer does and why the two read DIFFERENT variables.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS WRITES CSSOM DIRECTLY INSTEAD OF USING STATE.
 *
 * The component this replaces (`foil-shine.tsx`) called `setState` on every
 * `mousemove`. That was survivable when the only thing moving was a gradient
 * inside one small overlay; it is not survivable now that the card itself
 * tilts, because a state write re-renders the whole card subtree — cover
 * `<Image>` included — up to sixty times a second, and the library renders 180
 * of these.
 *
 * `element.style.setProperty()` sidesteps React's render cycle completely. It
 * is also strictly SAFER under this app's CSP than the old approach: CSP
 * governs `style` attributes appearing in markup (`style-src-attr`), not
 * CSSOM mutations, so this path is not policed at all — where the old inline
 * `style={{…}}` prop depended on the documented `style-src-attr 'unsafe-inline'`
 * exception continuing to exist.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `will-change` is applied on pointer-enter and removed on leave rather than
 * set in the stylesheet. Left on permanently it would promote a compositing
 * layer for all 180 cards at rest, which is exactly the pathology the property
 * is famous for.
 */
export function FoilCard({
  tone,
  className,
  children,
}: {
  /** `null` for an ordinary game — it still tilts and glares, it just has no foil layer. */
  readonly tone: FoilTone;
  readonly className?: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  const rootRef = useRef<HTMLSpanElement>(null);
  const rotatorRef = useRef<HTMLSpanElement>(null);

  function track(event: React.PointerEvent<HTMLSpanElement>): void {
    const root = rootRef.current;
    if (root === null) return;

    const rect = root.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    // 0→1 across the card, clamped: a pointer can be marginally outside the
    // box on the frame the browser reports `pointerleave`, and an unclamped
    // value there throws the tilt well past MAX_TILT_DEG for one frame.
    const px = clamp01((event.clientX - rect.left) / rect.width);
    const py = clamp01((event.clientY - rect.top) / rect.height);

    root.style.setProperty('--pointer-x', `${(px * 100).toFixed(2)}%`);
    root.style.setProperty('--pointer-y', `${(py * 100).toFixed(2)}%`);
    // Same numbers, but the stylesheet multiplies these up before using them as
    // a background-position — that difference in rate is the parallax.
    root.style.setProperty('--background-x', `${(px * 100).toFixed(2)}%`);
    root.style.setProperty('--background-y', `${(py * 100).toFixed(2)}%`);
    // Inverted on the Y axis so the card leans TOWARD the cursor: pointer at
    // the top should tip the top edge away from you, which is a negative
    // rotateX. Getting this backwards is subtle to spot and reads as "wrong"
    // without being obviously broken.
    root.style.setProperty('--rotate-x', `${((px - 0.5) * 2 * MAX_TILT_DEG).toFixed(2)}deg`);
    root.style.setProperty('--rotate-y', `${((0.5 - py) * 2 * MAX_TILT_DEG).toFixed(2)}deg`);
  }

  function engage(event: React.PointerEvent<HTMLSpanElement>): void {
    const root = rootRef.current;
    const rotator = rotatorRef.current;
    if (root === null || rotator === null) return;
    rotator.style.willChange = 'transform';
    root.style.setProperty('--card-opacity', '1');
    track(event);
  }

  function release(): void {
    const root = rootRef.current;
    const rotator = rotatorRef.current;
    if (root === null || rotator === null) return;
    root.style.setProperty('--card-opacity', '0');
    root.style.setProperty('--rotate-x', '0deg');
    root.style.setProperty('--rotate-y', '0deg');
    // Cleared only after the spring-back has finished — dropping the hint
    // mid-transition de-promotes the layer and the return visibly stutters.
    rotator.style.willChange = '';
  }

  return (
    <span
      ref={rootRef}
      // `data-foil` is absent, not `null`-valued, for an ordinary card: the
      // stylesheet's foil rules are keyed on the attribute EXISTING, so an
      // empty-string value would still match `[data-foil]` if anyone ever
      // loosens the selector.
      {...(tone === null ? {} : { 'data-foil': tone })}
      className={cn('foil-card relative block h-full w-full', className)}
      onPointerEnter={engage}
      onPointerMove={track}
      onPointerLeave={release}
    >
      <span ref={rotatorRef} className="foil-card__rotator relative block overflow-hidden rounded-md">
        {children}
        <span aria-hidden className="foil-card__glare" />
        {tone === null ? null : <span aria-hidden className="foil-card__shine" />}
      </span>
    </span>
  );
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
