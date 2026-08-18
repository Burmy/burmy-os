import { SubNav } from '@/features/shell/nav';

const LINKS = [
  { href: '/settings/finance/accounts', label: 'Accounts' },
  { href: '/settings/finance/categories', label: 'Categories' },
] as const;

/**
 * Switches between the two Finance settings screens. This is the only
 * sub-navigation left in the app — Finance itself (Monthly/Import/Review)
 * dropped its tab row in favor of the Import Sheet and an exception-driven
 * Review; Settings keeps one here because Accounts and Categories are two
 * genuinely separate maintenance screens the owner moves between.
 */
export default function SettingsFinanceLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return (
    <div className="space-y-6">
      <SubNav links={LINKS} />
      {children}
    </div>
  );
}
