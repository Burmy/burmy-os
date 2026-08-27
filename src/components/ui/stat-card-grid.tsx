import { cn } from '@/lib/utils';

/**
 * Every row of `StatCard`s in the app — one column rule, shared by Finance and
 * Games and by both the headline stats and the smaller insight cards.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A COMPONENT AND NOT A COPIED className.
 *
 * Gap and padding were already identical in both modules (16px and 24px). What
 * had drifted was the COLUMN COUNT, which each dashboard picked for itself
 * based on how many cards it happened to have: Games capped at 4, Finance at 6.
 * Measured on one 1500px screen that produced a 291x128 card in Games and a
 * 189x187 card in Finance — the same component, in the same app, at nearly
 * double the width and two-thirds the height.
 *
 * Finance came off worse for it. At 189px its comparison lines ("↓ $7,891.83
 * (74.5%) vs Jul") wrapped across three rows, which is the entire reason its
 * cards were so much taller.
 *
 * A shared component rather than a shared constant because the class string is
 * the whole behaviour — a constant would still let one caller append
 * `xl:grid-cols-6` and quietly diverge again.
 *
 * `StatCard` itself is already shared between the modules, so this is the same
 * kind of thing: a generic UI primitive, which is explicitly what CLAUDE.md
 * permits Finance and Games to have in common.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * FOUR across from `lg`, FIVE from `2xl`. Card counts in play are 5, 6 and 7,
 * so no column count avoids stranding one card alone on a row somewhere — that
 * is accepted rather than designed around. What matters is that a card is the
 * same width on every screen it appears on, which is what stops Finance and
 * Games looking like two different apps.
 */
export function StatCardGrid({
  children,
  className,
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
}): React.ReactElement {
  return (
    <div className={cn('grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5', className)}>{children}</div>
  );
}
