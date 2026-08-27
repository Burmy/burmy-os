import { cn } from '@/lib/utils';

/**
 * The row of `StatCard`s at the top of a dashboard — one column rule, shared by
 * Finance and Games.
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
 * Caps at FOUR, not more. Finance's month view has 6 cards and Games' has 7, so
 * a wider row would fit either one on a single line — but no column count
 * divides 5, 6 and 7 without stranding a card alone on a row, and 4 is the
 * widest that keeps every card readable at 1280px. Two tidy rows beat one row
 * of cramped cards.
 */
export function StatCardGrid({
  children,
  className,
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
}): React.ReactElement {
  return (
    <div className={cn('grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4', className)}>{children}</div>
  );
}
