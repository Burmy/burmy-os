import { SubNav } from '@/features/shell/nav';

const LINKS = [
  { href: '/finance/monthly', label: 'Monthly' },
  { href: '/finance/import', label: 'Import' },
] as const;

/**
 * Sub-navigation within Finance, same pattern as `settings/layout.tsx`. Without
 * it the M5 import screen would exist but be unreachable from anywhere in the
 * UI other than typing the URL.
 */
export default function FinanceLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return (
    <div className="space-y-8">
      <SubNav links={LINKS} />
      {children}
    </div>
  );
}
