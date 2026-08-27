'use client';

import { CircleCheck, OctagonX, X } from 'lucide-react';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { cn } from '@/lib/utils';

/**
 * Toasts — deliberately hand-written, replacing `sonner`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY NOT SONNER (which is what shadcn's template installs)
 *
 * Sonner injects its stylesheet as an inline `<style>` element at MODULE
 * EVALUATION time, through an internal `__insertCSS()` helper. It has no nonce
 * support at all (zero mentions in its bundle) and no way to suppress the
 * injection. Under Burmy's nonce-only `style-src` that tag is refused, and the
 * violation was intermittent because it raced with chunk loading — which is worse
 * than a consistent failure.
 *
 * The alternatives were: add `'unsafe-inline'` to `style-src`, which would permit
 * ANY injected stylesheet and was explicitly ruled out; or own ~80 lines of toast.
 * Styling here is ordinary Tailwind classes compiled into the same-origin
 * stylesheet, so there is nothing to nonce and nothing to refuse.
 *
 * Radix's own style element (`react-remove-scroll`) is a different matter — it
 * reads a nonce via `get-nonce`, so it stays nonce-controlled. See
 * src/features/shell/style-nonce.tsx.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const DISMISS_AFTER_MS = 5000;

export interface ToastMessage {
  readonly id: number;
  readonly kind: 'success' | 'error';
  readonly message: string;
}

// A minimal external store. `useSyncExternalStore` rather than a context +
// useState so `toast.success(...)` can be called from anywhere — including inside
// a transition callback — without threading a hook through every component.
let items: readonly ToastMessage[] = [];
let nextId = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): readonly ToastMessage[] {
  return items;
}

function dismiss(id: number): void {
  items = items.filter((item) => item.id !== id);
  emit();
}

function push(kind: ToastMessage['kind'], message: string): void {
  const id = (nextId += 1);
  items = [...items, { id, kind, message }];
  emit();

  // Errors linger; a success message that has already updated the page does not
  // need to be read.
  setTimeout(() => dismiss(id), kind === 'error' ? DISMISS_AFTER_MS * 2 : DISMISS_AFTER_MS);
}

export const toast = {
  success: (message: string): void => push('success', message),
  error: (message: string): void => push('error', message),
};

/**
 * The viewport. Mounted once, in the root layout.
 *
 * `role="status"` with `aria-live="polite"` so a screen reader announces the
 * outcome without stealing focus — these confirm an action the owner just took.
 */
export function Toaster(): React.ReactElement {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);

  // Clear anything left over when the viewport unmounts, so a stale message
  // cannot reappear on the next mount.
  useEffect(() => {
    return () => {
      items = [];
    };
  }, []);

  const onDismiss = useCallback((id: number) => dismiss(id), []);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end"
    >
      {current.map((item) => (
        <div
          key={item.id}
          className={cn(
            // Borderless like every other surface; the shadow is what
            // separates this floating layer from the page behind it. The
            // error variant keeps a destructive ring rather than a full
            // border — still a distinct signal, without reintroducing the
            // box chrome the rest of the app just shed.
            'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-md p-3 shadow-md',
            'bg-popover text-popover-foreground',
            item.kind === 'error' && 'ring-destructive/40 ring-1',
          )}
        >
          {item.kind === 'success' ? (
            <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
          ) : (
            <OctagonX className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden />
          )}

          <p className="flex-1 text-sm leading-relaxed">{item.message}</p>

          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => onDismiss(item.id)}
            className="text-muted-foreground hover:text-foreground -m-1 shrink-0 rounded-md p-1"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
