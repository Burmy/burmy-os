import { redirect } from 'next/navigation';

import {
  OnboardingIncompleteError,
  ReauthRequiredError,
  SecurityUnavailableError,
  UnauthorizedError,
  requireOwner,
} from '@/server/auth/owner';

/**
 * The authenticated area.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * This layout guards every page beneath it, including the monthly grid.
 *
 * It is NOT, however, the guard that matters for mutations. Server Actions are
 * POSTs to their host route and do not re-run a parent layout, so each one calls
 * `requireOwner()` itself — see docs/SECURITY.md and the enumeration test in
 * tests/integration/entry-points.test.ts. From M3 onward every page here also
 * calls `requireOwner()` directly, because it needs the returned owner id to
 * scope its queries; this layout is what makes an unauthenticated NAVIGATION
 * land somewhere sensible instead of rendering a shell.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export default async function PrivateLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): Promise<React.ReactElement> {
  // `redirect()` signals by throwing, so the destination is decided inside the
  // catch and acted on outside it. Calling redirect() in the catch block would
  // put its control-flow throw inside the handler that is inspecting errors.
  let destination: string | null = null;

  try {
    await requireOwner();
  } catch (error) {
    if (error instanceof UnauthorizedError) destination = '/sign-in';
    else if (error instanceof OnboardingIncompleteError) destination = '/onboarding/passkeys';
    else if (error instanceof ReauthRequiredError) destination = '/sign-in';
    else if (error instanceof SecurityUnavailableError) {
      // Deliberately NOT a redirect. The deployment cannot verify factor 1, and
      // sending the owner to a sign-in page would imply signing in could help.
      throw error;
    } else throw error;
  }

  if (destination) redirect(destination);

  return <>{children}</>;
}
