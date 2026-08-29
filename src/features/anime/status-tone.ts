import type { StatusTone } from '@/components/ui/status-badge';
import type { AnimeStatus } from '@/server/anime/taxonomy';

/**
 * Which of `StatusBadge`'s four tones each watch status deserves.
 *
 * Lives in `features/anime/` rather than in the taxonomy, which is
 * framework-free domain code with no business knowing about a UI palette —
 * the same split that keeps `STATUS_LABELS` (a fact about the domain) apart
 * from a color (a decision about a screen).
 *
 * `Record<AnimeStatus, …>` on purpose: adding a fifth status has to fail
 * typecheck here rather than render an undefined class.
 */
export const STATUS_TONES: Record<AnimeStatus, StatusTone> = {
  // Green for finished — the same "this is done" the Finance tables use.
  completed: 'positive',
  // Blue-ish neutral for in-progress: not a problem, not an achievement.
  watching: 'neutral',
  // Amber, the app's standing "needs attention" tone. A dropped show is not an
  // error, but it is the one state the owner may want to revisit.
  dropped: 'attention',
  // Muted for something not started — deliberately the quietest of the four,
  // because a Planning list is long and none of it has happened yet.
  planning: 'muted',
};
