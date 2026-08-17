import type { Metadata } from 'next';
import Link from 'next/link';

import { listCategories } from '@/server/db/finance/categories';
import { requireOwner } from '@/server/auth/owner';

export const metadata: Metadata = { title: 'Monthly — Burmy' };

/**
 * PLACEHOLDER. The real monthly grid is Milestone 8.
 *
 * It calls `requireOwner()` directly rather than relying on the parent layout —
 * not for the redirect (the layout does that) but because it needs the owner id
 * to scope its read. That is the pattern every page here follows from M3 onward:
 * the data-access layer takes an owner id and there is no way to query without
 * one.
 *
 * What it shows for now is the taxonomy, so entering categories in Settings has
 * visible effect before the grid exists to display them.
 */
export default async function MonthlyPage(): Promise<React.ReactElement> {
  const owner = await requireOwner();
  const categories = await listCategories(owner.userId);

  const spending = categories.filter((c) => c.kind === 'spending');
  const investment = categories.filter((c) => c.kind === 'investment');
  const income = categories.filter((c) => c.kind === 'income');

  return (
    <div>
      <h1 className="text-xl font-semibold">Monthly</h1>
      <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
        The category × month grid arrives in Milestone 8.{' '}
        <Link href="/finance/import" className="underline underline-offset-2">
          Import a statement
        </Link>{' '}
        to start adding transactions. Your row axis is below.
      </p>

      {categories.length === 0 ? (
        <p className="text-muted-foreground mt-8 text-sm">
          No categories yet. Add them under Settings → Categories.
        </p>
      ) : (
        <div className="mt-8 space-y-8">
          <Section title="Spending" names={spending.map((c) => c.name)} />
          <Section title="Investments" names={investment.map((c) => c.name)} />
          <Section title="Income" names={income.map((c) => c.name)} />
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  names,
}: {
  readonly title: string;
  readonly names: readonly string[];
}): React.ReactElement | null {
  if (names.length === 0) return null;

  return (
    <section>
      <h2 className="text-muted-foreground text-xs font-semibold tracking-widest uppercase">
        {title}
      </h2>
      <ul className="mt-3 divide-y border-t border-b">
        {names.map((name) => (
          <li key={name} className="py-2 text-sm">
            {name}
          </li>
        ))}
      </ul>
    </section>
  );
}
