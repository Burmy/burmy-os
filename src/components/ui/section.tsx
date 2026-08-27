/**
 * A borderless card with a heading — Finance's `ChartCard` and Games'
 * `Section` were byte-for-byte the same idea implemented twice, plus a
 * third hand-rolled copy for Finance's "Largest expenses this month" card.
 *
 * No border — real usage found bordered-box-everywhere the biggest
 * contributor to a "compact/scattered" feel. The card reads against the
 * page through its surface fill alone, which is why `--card` was changed to
 * differ from `--background` in light mode (they were both `#ffffff`, so a
 * borderless `bg-card` box was literally invisible — see that token's own
 * comment in `globals.css`).
 *
 * Padding (24px = `p-6`) matches `StatCard`'s exactly. These two are the
 * app's only shared "card" primitives and they used to disagree (`p-6` vs
 * `p-5`), which is what made Finance and Games look inconsistent.
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
    <section className="rounded-md bg-card p-6">
      <h2 className="font-display text-base font-medium">{title}</h2>
      {description ? <p className="text-muted-foreground text-xs">{description}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}
