/**
 * A bordered card with a heading — Finance's `ChartCard` and Games'
 * `Section` were byte-for-byte the same idea (title, optional description,
 * bordered box, `mt-3` before the content) implemented twice, plus a third
 * hand-rolled copy of the same markup for Finance's "Largest expenses this
 * month" card. Unified on Finance's shape (`bg-card`, `p-5`) since Finance
 * is the higher-traffic, daily-use surface — Games' boxes pick up the same
 * fill and slightly larger padding as a result.
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
    <section className="rounded-lg border bg-card p-5">
      <h2 className="text-sm font-medium">{title}</h2>
      {description ? <p className="text-muted-foreground text-xs">{description}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}
