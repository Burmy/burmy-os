import { redirect } from 'next/navigation';

/** Settings has no landing page of its own; Accounts is the first section. */
export default function SettingsIndex(): never {
  redirect('/settings/accounts');
}
