import { SubNav } from '@/features/shell/nav';

const LINKS = [
  { href: '/settings/accounts', label: 'Accounts' },
  { href: '/settings/categories', label: 'Categories' },
  { href: '/settings/passkeys', label: 'Passkeys' },
] as const;

export default function SettingsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return (
    <div className="space-y-8">
      <SubNav links={LINKS} />
      {children}
    </div>
  );
}
