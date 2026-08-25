import { cn } from '@/lib/utils';

/**
 * Page-level heading: a title, an optional subtitle underneath, and an
 * optional actions slot flush right. Replaces three previously-separate
 * shapes — a bare `<h1>` + muted `<p>` (most pages), Finance Monthly's
 * `text-lg` title embedded in a bordered toolbar card beside the period
 * selector and view toggle, and Games' Stats page having no header at all.
 *
 * `className` and `titleClassName` exist for exactly one caller — Finance
 * Monthly, which renders inside its own bordered/`bg-card` toolbar at a
 * slightly smaller title size and folds its period selector and view toggle
 * into `actions` alongside the page-level buttons, rather than this
 * component growing a second, toolbar-specific prop shape for one screen.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  className,
  titleClassName,
}: {
  readonly title: React.ReactNode;
  readonly subtitle?: React.ReactNode;
  readonly actions?: React.ReactNode;
  readonly className?: string;
  readonly titleClassName?: string;
}): React.ReactElement {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3', className)}>
      <div>
        <h1 className={cn('text-xl font-semibold', titleClassName)}>{title}</h1>
        {subtitle ? <p className="text-muted-foreground mt-1 text-sm">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
