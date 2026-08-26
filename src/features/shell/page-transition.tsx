'use client';

import { usePathname } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';

/**
 * A light cross-fade + rise between routes, keyed on the pathname — real
 * usage found navigating between pages felt like a flat reload with zero
 * transition. `AnimatePresence` needs the outgoing tree to still be
 * mounted while it animates out, so `mode="wait"` holds the new route
 * until the old one has finished leaving; `initial={false}` skips the
 * animation on first load (a fade-in on the very first paint would just
 * be extra latency before the owner sees anything).
 *
 * Motion animates through the `style` ATTRIBUTE, not an injected `<style>`
 * element — governed by `style-src-attr`, not the nonce-only `style-src`
 * this app is strict about. Already covered by the narrow
 * `style-src-attr 'unsafe-inline'` exception `style-nonce.tsx` documents
 * for Radix — confirmed live with a `securitypolicyviolation` listener
 * before this was built out further, this app's own established method
 * for diagnosing CSP issues (see that file's own doc comment).
 */
export function PageTransition({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  const pathname = usePathname();

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={pathname}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
