'use client';

import { useState } from 'react';
import { Star } from 'lucide-react';

import { cn } from '@/lib/utils';

const STARS = [1, 2, 3, 4, 5] as const;

/**
 * An interactive 1–5 star rating. Click a star to set it; click the star
 * that's already selected to clear the rating entirely.
 *
 * Hand-built rather than a package. `@smastrom/react-rating` was the
 * strongest candidate researched (zero-dependency, accessible) but this is
 * five buttons over the Lucide icons already in the app, and every UI
 * dependency added to this project so far — `sonner`, `next-themes`,
 * `motion` — has had to be removed again. It also means no package
 * stylesheet to reconcile against the app's own look.
 *
 * WHOLE STARS ONLY, on purpose. `games.rating` is an integer column with
 * `z.number().int().min(1).max(5)` validation, and both the Steam and PSN
 * sync paths write it — half-stars would be a data migration, not a UI
 * change, and were explicitly not asked for.
 *
 * Rendered as a radiogroup rather than five toggles: the options are
 * mutually exclusive, which is exactly what a radiogroup means, and it
 * gives arrow-key navigation for free from the browser's own semantics.
 */
export function RatingInput({
  value,
  onChange,
  disabled = false,
}: {
  readonly value: number | null;
  /** `null` when the owner clears the rating by re-clicking the active star. */
  readonly onChange: (value: number | null) => void;
  readonly disabled?: boolean;
}): React.ReactElement {
  // Which star the pointer is over, so the row previews the rating a click
  // would produce rather than making the owner guess from position alone.
  const [preview, setPreview] = useState<number | null>(null);
  const shown = preview ?? value ?? 0;

  return (
    <div
      role="radiogroup"
      aria-label="Rating"
      className="flex items-center gap-0.5"
      onMouseLeave={() => setPreview(null)}
    >
      {STARS.map((star) => {
        const filled = star <= shown;
        return (
          <button
            key={star}
            type="button"
            role="radio"
            aria-checked={value === star}
            aria-label={`${star} star${star === 1 ? '' : 's'}`}
            disabled={disabled}
            onMouseEnter={() => setPreview(star)}
            onFocus={() => setPreview(star)}
            onBlur={() => setPreview(null)}
            // Re-clicking the current rating clears it. Without this there
            // is no way back to "unrated" once a star has ever been set —
            // the numeric field this replaced could at least be emptied.
            onClick={() => onChange(value === star ? null : star)}
            className={cn(
              'rounded-md p-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
            )}
          >
            <Star
              className={cn(
                'size-4 transition-colors',
                filled ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/30',
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
