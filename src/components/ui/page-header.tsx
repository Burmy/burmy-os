import { cn } from '@/lib/utils';

/**
 * Page-level heading: a title, an optional subtitle underneath, and an
 * optional actions slot flush right. Replaces three previously-separate
 * shapes — a bare `<h1>` + muted `<p>` (most pages), Finance Monthly's
 * `text-lg` title embedded in a bordered toolbar card beside the period
 * selector and view toggle, and Games' Stats page having no header at all.
 *
 * Every page header in the app renders the same flat, borderless shape now
 * — Finance Monthly and Games Stats used to each get their own bordered/
 * `bg-card` toolbar box via `className`/`titleClassName`, which made the
 * header chrome inconsistent from screen to screen; both reverted to this
 * plain shape. `titleClassName` had no other caller and was removed
 * outright. `className` survives — it still has two unrelated legitimate
 * callers (`finance/import/[importId]`, `games/sync/[runId]`) that need a
 * plain `mt-2` to sit closer to the "← Back" link above them, nothing to do
 * with the toolbar box.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  className,
}: {
  readonly title: React.ReactNode;
  readonly subtitle?: React.ReactNode;
  readonly actions?: React.ReactNode;
  readonly className?: string;
}): React.ReactElement {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3', className)}>
      <div>
        {/* `inline-block` so the underline hugs the text width, not the
            full flex-item width — the accent sits directly under the
            words themselves, not spanning the header row. */}
        <h1 className="font-display border-b-2 border-brand inline-block pb-1 text-3xl font-medium tracking-tight">
          {title}
        </h1>
        {subtitle ? <p className="text-muted-foreground mt-2 text-sm">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
