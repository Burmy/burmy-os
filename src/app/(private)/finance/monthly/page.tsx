import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Monthly — Burmy' };

/**
 * PLACEHOLDER.
 *
 * The real monthly grid is Milestone 8. This exists so that `/` has somewhere
 * to redirect to and the route tree is correct from the start.
 *
 * When implemented, this page renders the category x month pivot computed in
 * SQL, with the Spending and Income sections split on `category.kind` and
 * cell drill-down replacing the old Excel comments.
 */
export default function MonthlyPage(): React.ReactElement {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <p className="text-xs font-medium tracking-widest uppercase opacity-50">Burmy</p>
      <h1 className="mt-2 text-2xl font-semibold">Finance — Monthly</h1>
      <p className="mt-4 text-sm leading-relaxed opacity-70">
        Foundation is in place. The monthly grid arrives in Milestone 8; the importer that fills it
        arrives in Milestone 5.
      </p>
      <p className="mt-8 text-xs opacity-50">
        Milestone 1 — project skeleton, database schema, and the money core.
      </p>
    </main>
  );
}
