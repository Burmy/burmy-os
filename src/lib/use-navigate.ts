'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

/**
 * `router.push` with a pending flag.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE GAP THIS CLOSES, AND WHY `loading.tsx` DOES NOT CLOSE IT
 *
 * A route-level `loading.tsx` only renders when the navigation crosses a
 * SEGMENT boundary. Most navigation in this app does not: changing the month,
 * the year, a category filter or a status chip pushes a new query string on
 * the SAME route. No boundary is crossed, so no fallback appears, and the page
 * simply sits there — showing the previous month's numbers — until the server
 * responds. Nothing on screen acknowledges the click at all.
 *
 * That is the majority of the interaction in Finance, and it is what "the
 * transitions are laggy and there is no indication" describes most precisely:
 * the app is not only slow, it is silent about being slow, which makes the
 * same latency read as a broken control rather than a working one.
 *
 * Wrapping the push in `startTransition` makes React report it as pending for
 * exactly as long as the server takes, which is the signal every caller here
 * renders — an inline spinner on the control, a busy line under the filter
 * bar, a spinner on the row that was clicked.
 *
 * WHY A TRANSITION AND NOT A PLAIN `useState` FLAG. A manual flag has to be
 * cleared, and the only honest place to clear it is "when the new page
 * commits" — which client code cannot observe. `useTransition` is scoped to
 * the actual work: React clears it when the navigation resolves, including
 * when it resolves by failing.
 *
 * WHY NOT ONE GLOBAL PROGRESS BAR. It was the first design. A single bar at
 * the top of the viewport is further from the control than the control is
 * from the pointer, so on a wide screen the feedback appears somewhere the
 * eye is not — and it cannot say WHICH of several controls is working. Local
 * feedback costs one small component per call site and says more.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function useNavigate(): {
  readonly navigate: (href: string) => void;
  readonly pending: boolean;
} {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return {
    navigate: (href: string) => startTransition(() => router.push(href)),
    pending,
  };
}
