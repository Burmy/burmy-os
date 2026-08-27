'use client';

import { Button } from '@/components/ui/button';

/**
 * Error boundary for the authenticated area.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SHOWS A CORRELATION ID, NEVER A MESSAGE.
 *
 * Plan §37: "Error pages surface a correlation id, so problems are traceable
 * without logs holding financial content." Next.js gives us `error.digest` for
 * exactly this — a hash of the server-side error that appears in the server log
 * alongside the real stack, so the owner can quote a short string and the log
 * holds the detail.
 *
 * `error.message` is deliberately not rendered. In production Next redacts it
 * anyway, but rendering it in development trains everyone to expect it on screen
 * — and the messages in this application are assembled from statement
 * descriptions, table names and query text.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export default function PrivateError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}): React.ReactElement {
  return (
    <div className="mx-auto max-w-md py-16">
      <h1 className="text-xl font-semibold">Something went wrong</h1>

      <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
        The error was logged on the server. If you need to report it, quote the
        reference below — it identifies this exact failure without putting your
        financial data in a bug report.
      </p>

      {error.digest ? (
        <p className="mt-4 text-sm">
          <span className="text-muted-foreground">Reference </span>
          <code className="bg-muted rounded-md px-1.5 py-0.5 font-mono">{error.digest}</code>
        </p>
      ) : null}

      <div className="mt-8 flex gap-2">
        <Button onClick={reset} variant="outline">
          Try again
        </Button>
      </div>
    </div>
  );
}
