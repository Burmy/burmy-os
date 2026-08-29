'use client';

import Image from 'next/image';
import { useState } from 'react';
import { Gamepad2 } from 'lucide-react';

import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { PlatinumBadge } from '@/components/games/platinum-badge';
import { RatingInput } from '@/components/games/rating-input';
import { toast } from '@/components/ui/toast';
import type { ActionResult } from '@/features/games/action-result';
import type { GameFieldKey } from '@/features/games/game-actions';
import { formatHours, hours } from '@/server/games/hours';
import { PLATFORM_LABELS, STATUS_LABELS } from '@/server/games/taxonomy';
import type { GamePlatform, GameStatus } from '@/server/games/taxonomy';
import { PLATFORM_PICKER_OPTIONS } from '@/server/games/taxonomy';
import { cn } from '@/lib/utils';
import { InlineEditField, InlineEditSelect, ROW_CLASS } from '@/components/ui/inline-edit-row';

const STATUS_OPTIONS = [
  'backlog',
  'wanted',
  'playing',
  'played',
] as const satisfies readonly GameStatus[];

/**
 * The page's persistent left column — cover art plus the same "at a
 * glance" facts `GameCard` shows in the library gallery (platform, rating,
 * hours), every one of them independently inline-editable now (see
 * `@/components/ui/inline-edit-row`'s own doc comment for why the whole page moved off
 * a single Edit/Save toggle).
 */
export function GameSummaryPanel({
  coverUrl,
  title,
  platform,
  status,
  rating,
  hoursTenths,
  platinum,
  steamOwned,
  collectionOwned,
  onSaveField,
}: {
  readonly coverUrl: string | null;
  readonly title: string;
  readonly platform: GamePlatform;
  readonly status: GameStatus;
  readonly rating: number | null;
  readonly hoursTenths: number | null;
  readonly platinum: boolean;
  readonly steamOwned: boolean;
  /**
   * This game sits inside a collection, which owns the set's single play-time
   * figure. Same "the value lives elsewhere" treatment as `steamOwned`, and
   * checked second when both apply — Steam is the one that actually rewrites
   * the number on every sync, so its hint is the more useful of the two.
   */
  readonly collectionOwned: boolean;
  readonly onSaveField: (field: GameFieldKey, value: string) => Promise<ActionResult>;
}): React.ReactElement {
  return (
    <div className="space-y-4 sm:sticky sm:top-6">
      <div className="bg-muted relative aspect-[3/4] w-full overflow-hidden rounded-md">
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

      {/* No `divide-y`. This panel sits directly beside the detail column,
          which dropped its per-row rules when the label moved next to its
          value — leaving them here would make one page use two row languages
          three inches apart. */}
      <div>
        <InlineEditSelect
          label="Platform"
          value={platform}
          displayValue={PLATFORM_LABELS[platform]}
          options={(platform === 'pc'
            ? [...PLATFORM_PICKER_OPTIONS, 'pc' as const]
            : PLATFORM_PICKER_OPTIONS
          ).map((value) => ({ value, label: PLATFORM_LABELS[value] }))}
          onSave={(value) => onSaveField('platform', value)}
        />
        <InlineEditSelect
          label="Status"
          value={status}
          displayValue={STATUS_LABELS[status]}
          options={STATUS_OPTIONS.map((value) => ({ value, label: STATUS_LABELS[value] }))}
          onSave={(value) => onSaveField('status', value)}
        />
        <RatingRow rating={rating} onSave={(value) => onSaveField('rating', value)} />
        <InlineEditField
          label="Hours"
          value={hoursTenths === null ? '' : String(hoursTenths / 10)}
          displayValue={hoursTenths === null ? undefined : formatHours(hours(hoursTenths))}
          placeholder="Not tracked"
          disabled={steamOwned || collectionOwned}
          disabledHint={steamOwned ? 'From Steam' : 'From the collection'}
          onSave={(value) => onSaveField('hours', value)}
        />
        <div className={cn(ROW_CLASS, 'items-center')}>
          <Label
            htmlFor="platinum-toggle"
            className="text-muted-foreground cursor-pointer font-normal"
          >
            Platinum
          </Label>
          <Checkbox
            id="platinum-toggle"
            checked={platinum}
            onCheckedChange={(checked) => {
              void onSaveField('platinum', checked === true ? 'true' : '').then((result) => {
                if (!result.ok) toast.error(result.error);
              });
            }}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Rating is the one field that is DIRECTLY interactive rather than
 * click-to-reveal-an-input: clicking a star both sets and commits the
 * value, because a star row is already the control — making the owner
 * click it once to reveal a numeric box, then type a digit, was the wrong
 * shape for a rating and is what this replaced. Re-clicking the active
 * star clears the rating, which is the only way back to "unrated."
 *
 * Still one round-trip per change, same as every other field here.
 */
function RatingRow({
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
