import { cookies } from 'next/headers';

/**
 * Theme preference — a cookie, read on the server.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY NOT `next-themes`
 *
 * It prevents the flash of wrong theme by injecting an inline <script> that runs
 * before paint. Burmy's CSP is nonce-only for scripts with no `'unsafe-inline'`,
 * so that script is blocked — the library would either silently fail or force a
 * nonce to be threaded into it.
 *
 * Reading a cookie server-side and stamping a class on <html> during SSR achieves
 * the same no-flash result with zero JavaScript, zero dependencies, and nothing
 * for the CSP to refuse. The cost is that switching themes is a round trip
 * instead of instant — for an application opened once a month, that is not a
 * cost worth a dependency and a CSP exception.
 *
 * THREE STATES, not two. `system` emits NO class, which lets the
 * `prefers-color-scheme` rules in globals.css apply. Defaulting to `light`
 * instead would quietly ignore the OS setting for anyone who never opens
 * settings.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const THEME_COOKIE = 'burmy.theme';

const THEMES = ['system', 'light', 'dark'] as const;

export type Theme = (typeof THEMES)[number];

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

/** The preference, or `system` when unset or unrecognised. */
export async function readTheme(): Promise<Theme> {
  const store = await cookies();
  const value = store.get(THEME_COOKIE)?.value;
  return isTheme(value) ? value : 'system';
}

/**
 * The class for `<html>`.
 *
 * `system` deliberately returns an empty string so the media-query rules win.
 * `light` needs an explicit class because it has to override system-dark — that
 * is what the `:root:not(.light)` guard in globals.css is for.
 */
export function themeClass(theme: Theme): string {
  return theme === 'system' ? '' : theme;
}

/**
 * Cookie attributes.
 *
 * Not `httpOnly`: nothing secret is stored, and a theme choice is not a
 * credential. It is host-only and `SameSite=Lax` like every other cookie Burmy
 * sets — never `Domain=.burmy.me`, which would leak it to the public portfolio
 * and, more importantly, is the habit that must not exist in this codebase at all.
 */
export function themeCookieOptions(): {
  path: string;
  sameSite: 'lax';
  maxAge: number;
  secure: boolean;
} {
  return {
    path: '/',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
    secure: process.env.NODE_ENV === 'production',
  };
}
