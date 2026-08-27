'use client';

import { useState } from 'react';

import { cn } from '@/lib/utils';

/**
 * A cursor-tracked highlight over a card's cover art — the way tilting a
 * foil trading card catches the light.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, AND WHY IT ONLY APPEARS ON HOVER.
 *
 * Platinum and wishlist cards carry a raised `bg-card` surface at REST —
 * which is exactly the surface a plain card only gets ON hover. That left
 * them with no state change to make: hovering a platinum card did visibly
 * nothing, which real usage caught.
 *
 * The shine is strictly a hover state. At rest the grid stays flat and
 * monochrome, so this does not reopen the app's no-gradients direction —
 * there is no gradient on screen until the pointer is actually over a card.
 *
 * Platinum and wishlist deliberately get DIFFERENT tones. Platinum is an
 * achievement and reads warm silver/white; wishlist is an aspiration, not a
 * prize, so it stays cooler and dimmer. That distinction was set in an
 * earlier round and this preserves it rather than flattening both into one
 * effect.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The cursor position rides in on two CSS custom properties set through an
 * inline `style` ATTRIBUTE. That is governed by `style-src-attr`, which this
 * app already relaxes as a narrow documented exception (see
 * `src/server/security/csp.ts`) — `style-src` itself stays nonce-only, and
 * no `<style>` element is injected. No animation library: `motion` was
 * removed from this project deliberately and is not coming back for this.
 *
 * Render this INSIDE the cover's existing `overflow-hidden` wrapper so the
 * highlight clips to the art rather than bleeding over the card's corners.
 */
export function FoilShine({ tone }: { readonly tone: 'platinum' | 'wishlist' }): React.ReactElement {
  // `null` until the pointer has actually moved over the card, so the
  // highlight never renders parked at a stale or default coordinate.
  const [position, setPosition] = useState<{ readonly x: number; readonly y: number } | null>(null);

  return (
    <span
      aria-hidden
      onMouseMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setPosition({
          x: ((event.clientX - rect.left) / rect.width) * 100,
          y: ((event.clientY - rect.top) / rect.height) * 100,
        });
      }}
      onMouseLeave={() => setPosition(null)}
      className="absolute inset-0 z-10"
    >
      <span
        className={cn(
          'absolute inset-0 opacity-0 transition-opacity duration-200',
          position !== null && 'opacity-100',
        )}
        style={
          position === null
            ? undefined
            : {
                // A soft radial hotspot at the cursor. `--tw-*` is avoided
                // on purpose — this is a real computed gradient, not a
                // utility, and Tailwind has no arbitrary-value syntax that
                // reads a runtime coordinate.
                background:
                  tone === 'platinum'
                    ? `radial-gradient(circle 12rem at ${position.x}% ${position.y}%, rgba(255,255,255,0.28), rgba(226,232,240,0.10) 40%, transparent 70%)`
                    : `radial-gradient(circle 12rem at ${position.x}% ${position.y}%, rgba(203,213,225,0.14), rgba(148,163,184,0.05) 40%, transparent 70%)`,
              }
        }
      />
    </span>
  );
}
