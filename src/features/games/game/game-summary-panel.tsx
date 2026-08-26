import Image from 'next/image';
import { Gamepad2 } from 'lucide-react';

import { PlatinumBadge } from '@/components/games/platinum-badge';
import { RatingStars } from '@/components/games/rating-stars';
import { formatHours, hours } from '@/server/games/hours';
import { PLATFORM_LABELS, STATUS_LABELS } from '@/server/games/taxonomy';
import type { GamePlatform, GameStatus } from '@/server/games/taxonomy';

/**
 * The page's persistent left column — cover art plus the same "at a
 * glance" facts `GameCard` shows in the library gallery (platform, rating,
 * hours), always read-only regardless of whether the right column is in
 * view or edit mode. Deliberately NOT `StatusBadge`: that component
 * returns `null` for `played`/`playing` (the majority library state, kept
 * invisible in a dense grid), which would leave a detail page's status row
 * blank for most games — this renders `STATUS_LABELS` as plain text
 * instead, so a status is always visible here.
 */
export function GameSummaryPanel({
  coverUrl,
  title,
  platform,
  status,
  rating,
  hoursTenths,
  platinum,
}: {
  readonly coverUrl: string | null;
  readonly title: string;
  readonly platform: GamePlatform;
  readonly status: GameStatus;
  readonly rating: number | null;
  readonly hoursTenths: number | null;
  readonly platinum: boolean;
}): React.ReactElement {
  return (
    <div className="space-y-3 sm:sticky sm:top-6">
      <div className="bg-muted relative aspect-[3/4] w-full overflow-hidden rounded-lg">
        {coverUrl === null || coverUrl === '' ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5" aria-hidden>
            <span className="text-muted-foreground/40 text-4xl font-semibold">
              {title.trim().charAt(0).toUpperCase()}
            </span>
            <Gamepad2 className="text-muted-foreground/25 size-5" />
          </div>
        ) : (
          <Image src={coverUrl} alt="" fill sizes="280px" className="object-cover" />
        )}
        {platinum ? <PlatinumBadge className="absolute top-2 right-2" /> : null}
      </div>

      <dl className="space-y-1.5 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">Platform</dt>
          <dd>{PLATFORM_LABELS[platform]}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">Status</dt>
          <dd>{STATUS_LABELS[status]}</dd>
        </div>
        {rating === null ? null : (
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Rating</dt>
            <dd>
              <RatingStars rating={rating} />
            </dd>
          </div>
        )}
        {hoursTenths === null ? null : (
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Hours</dt>
            <dd className="tabular">{formatHours(hours(hoursTenths))}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
