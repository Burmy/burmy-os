import { redirect } from 'next/navigation';

import { MobileNav } from '@/features/shell/mobile-nav';
import { Sidebar } from '@/features/shell/sidebar';
import { ThemeToggle } from '@/features/shell/theme-toggle';
import { SecurityUnavailableError, UnauthorizedError, requireOwner } from '@/server/auth/owner';
import { readTheme } from '@/server/security/theme';

/**
 * The authenticated area.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * This layout guards every page beneath it, and it is NOT the guard that matters
 * for mutations. Server Actions are POSTs to their host route and do not re-run a
 * parent layout, so each one calls `requireOwner()` itself — see
 * docs/SECURITY.md and the enumeration test in
 * tests/integration/entry-points.test.ts.
 *
 * Pages here also call `requireOwner()` directly, because they need the returned
 * owner id to scope their queries. This layout is what makes an unauthenticated
 * NAVIGATION land somewhere sensible instead of rendering an empty shell.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export default async function PrivateLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): Promise<React.ReactElement> {
  // `redirect()` signals by throwing, so the destination is decided inside the
  // catch and acted on outside it. Calling redirect() in the catch block would
  // put its control-flow throw inside the handler inspecting errors.
  let destination: string | null = null;

  try {
    await requireOwner();
  } catch (error) {
    if (error instanceof UnauthorizedError) destination = '/access-denied';
    else if (error instanceof SecurityUnavailableError) {
      // Deliberately NOT a redirect. The deployment cannot verify Cloudflare
      // Access, and sending the owner to an "access denied" page would imply
      // there is something to do about it — there isn't; it's an outage.
      throw error;
    } else throw error;
  }

  if (destination) redirect(destination);

  const theme = await readTheme();

  return (
    <div className="flex min-h-screen">
      <Sidebar footer={<ThemeToggle current={theme} />} />

      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        <header className="border-b md:hidden">
          <div className="flex items-center gap-2 px-4 py-3">
            <MobileNav />
            <span className="text-xs font-semibold tracking-widest uppercase">Burmy</span>
            <div className="ml-auto">
              <ThemeToggle current={theme} />
            </div>
          </div>
        </header>

        {/* `min-w-0` overrides the flex-item default of `min-width: auto`, which
            otherwise lets a wide descendant (the monthly grid table, which can
            run to a dozen+ columns) push this whole flex chain wider than the
            viewport instead of scrolling inside its own `overflow-x-auto`. */}
        <main className="mx-auto w-full min-w-0 max-w-6xl flex-1 px-4 py-8 sm:px-6">{children}</main>
      </div>
    </div>
  );
}
