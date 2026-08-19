import { redirect } from 'next/navigation';

/**
 * Categories is the only Finance settings screen left — Accounts is gone
 * entirely (round-2 UX pass: account choice is now fully automatic, derived
 * from the imported file's format, never something the owner manages). With
 * one destination, a landing page of links plus a SubNav tab bar for that
 * single tab would both be pure ceremony, so this redirects straight there.
 */
export default function SettingsPage(): never {
  redirect('/settings/finance/categories');
}
