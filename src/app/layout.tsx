import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { Space_Grotesk } from 'next/font/google';

import { Toaster } from '@/components/ui/toast';
import { StyleNonce } from '@/features/shell/style-nonce';
import { cn } from '@/lib/utils';
import { NONCE_HEADER } from '@/server/security/csp';
import { readTheme, themeClass } from '@/server/security/theme';

import './globals.css';

// Self-hosted at build time (next/font downloads and serves the font files
// from this app's own domain) — no runtime <link>/<style> injection, so this
// carries no CSP risk unlike a client-side Google Fonts loader would.
// Exposed as a CSS variable, not `className` on <html>, so it layers in as
// one more token (`--font-display`) beside the existing `--font-sans`
// rather than replacing the whole app's font wholesale.
const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Burmy',
  description: 'Private personal workspace',
  // Private application. Never index, never follow, never cache a snippet.
  robots: { index: false, follow: false, nocache: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

/**
 * The theme class is resolved DURING SSR from a cookie, so the correct palette is
 * in the very first byte of HTML. No inline script, nothing for the CSP to block,
 * and no flash of the wrong theme. See src/server/security/theme.ts.
 *
 * Reading a cookie makes every route dynamic, which is already true here: the
 * only static route is /access-denied, and it is trivial.
 */
export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): Promise<React.ReactElement> {
  const [theme, requestHeaders] = await Promise.all([readTheme(), headers()]);

  // Set by src/proxy.ts on every request. Radix injects a real <style> element
  // for its scroll lock, and `style-src` is nonce-only — see StyleNonce.
  const nonce = requestHeaders.get(NONCE_HEADER) ?? '';

  return (
    <html lang="en" className={cn(themeClass(theme), spaceGrotesk.variable)} suppressHydrationWarning>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <StyleNonce nonce={nonce} />
        {children}
        <Toaster />
      </body>
    </html>
  );
}
