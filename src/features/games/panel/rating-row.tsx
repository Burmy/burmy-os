'use client';

import { useState } from 'react';

import { RatingInput } from '@/components/games/rating-input';
import { ROW_CLASS } from '@/components/ui/inline-edit-row';
import { toast } from '@/components/ui/toast';
import type { ActionResult } from '@/features/games/action-result';
import { cn } from '@/lib/utils';

/**
 * Rating is the one field that is DIRECTLY interactive rather than
 * click-to-reveal-an-input: clicking a star both sets and commits the
 * value, because a star row is already the control — making the owner
 * click it once to reveal a numeric box, then type a digit, was the wrong
 * shape for a rating and is what this replaced. Re-clicking the active
 * star clears the rating, which is the only way back to "unrated."
 *
 * Still one round-trip per change, same as every other field in the panel.
 */
export function RatingRow({
  rating,
  onSave,
}: {
  readonly rating: number | null;
  readonly onSave: (value: string) => Promise<ActionResult>;
}): React.ReactElement {
  const [pending, setPending] = useState(false);

  async function save(next: number | null): Promise<void> {
    setPending(true);
    const result = await onSave(next === null ? '' : String(next));
    setPending(false);
    if (!result.ok) toast.error(result.error);
  }

  return (
    <div className={cn(ROW_CLASS, 'items-center')}>
      <span className="text-muted-foreground">Rating</span>
      <RatingInput value={rating} disabled={pending} onChange={(next) => void save(next)} />
    </div>
  );
}
