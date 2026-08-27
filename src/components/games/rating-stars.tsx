import { Star } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Read-only 1-5 display. Renders nothing at all when unrated — an empty row of
 * hollow stars reads as "rated zero", which is a different claim from "not yet
 * rated".
 */
export function RatingStars({ rating }: { readonly rating: number | null }): React.ReactElement | null {
  if (rating === null) return null;

  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${rating} out of 5`}>
      {[1, 2, 3, 4, 5].map((position) => (
        <Star
          key={position}
          aria-hidden
          className={cn(
            'size-3.5',
            position <= rating ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/30',
          )}
        />
      ))}
    </span>
  );
}
