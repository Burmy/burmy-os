'use client';

import { Plus } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import type { ActionResult } from '@/features/games/action-result';
import {
  isRealPlayYearDraft,
  type PlayYearDraft,
  PlayYearsPanel,
} from '@/features/games/play-years-panel';

/**
 * The one field that isn't a scalar (an array of {year, hours} rows), so it
 * doesn't fit `InlineEditField`/`InlineEditSelect`: a toggle reveals
 * `PlayYearsPanel`, edits stay local drafts while open, one explicit save
 * commits the whole split at once. Used by only the ~3 games out of 160
 * that track a split at all, which is why it starts collapsed unless a split
 * already exists.
 */
export function PlayYearsRow({
  hoursTenths,
  playYears,
  onSave,
}: {
  readonly hoursTenths: number | null;
  readonly playYears: readonly { readonly year: number; readonly hoursTenths: number }[];
  readonly onSave: (drafts: readonly PlayYearDraft[]) => Promise<ActionResult>;
}): React.ReactElement {
  const [open, setOpen] = useState(playYears.length > 0);
  const [drafts, setDrafts] = useState<readonly PlayYearDraft[]>(() =>
    playYears.map((row) => ({ year: String(row.year), hours: String(row.hoursTenths / 10) })),
  );
  const [saving, setSaving] = useState(false);

  if (!open) {
    return (
      <div className="py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground -ml-2 gap-1.5 px-2"
          onClick={() => setOpen(true)}
        >
          <Plus className="size-4" aria-hidden />
          Split across years
        </Button>
      </div>
    );
  }

  async function save(): Promise<void> {
    setSaving(true);
    const result = await onSave(drafts.filter(isRealPlayYearDraft));
    setSaving(false);
    if (!result.ok) toast.error(result.error);
  }

  return (
    <div className="py-2">
      <PlayYearsPanel value={drafts} onChange={setDrafts} totalTenths={hoursTenths ?? 0} />
      <Button
        type="button"
        size="sm"
        className="mt-2"
        disabled={saving}
        onClick={() => void save()}
      >
        {saving ? 'Saving…' : 'Save split'}
      </Button>
    </div>
  );
}
