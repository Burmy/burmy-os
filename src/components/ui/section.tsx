/**
 * A borderless card with a heading — Finance's `ChartCard` and Games'
 * `Section` were byte-for-byte the same idea implemented twice, plus a
 * third hand-rolled copy for Finance's "Largest expenses this month" card.
 *
 * No border — real usage found bordered-box-everywhere the biggest
 * contributor to a "compact/scattered" feel. The card reads against the
 * page via a tonal fill instead (`bg-muted`, not `bg-card` — this app's own
 * `--card` token is IDENTICAL to `--background` in light mode, so a
 * borderless `bg-card` box would be invisible against the page; `--muted`
 * is the token that actually contrasts in both themes). Padding
 * (`{spacing.2xl}` 24px = Tailwind's `p-6`) matches `StatCard`'s own —
 * previously `p-6` vs `p-5`, a real inconsistency between this app's two
 * shared "card" primitives that real usage called out directly.
 */
export function Section({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="rounded-lg bg-muted p-6">
      <h2 className="font-display text-base font-medium">{title}</h2>
      {description ? <p className="text-muted-foreground text-xs">{description}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}
