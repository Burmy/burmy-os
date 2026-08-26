'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import type { ActionResult } from '@/features/games/action-result';
import type { GameFieldKey } from '@/features/games/game-actions';
import { isRealPlayYearDraft, PlayYearsPanel, type PlayYearDraft } from '@/features/games/play-years-panel';
import { GAME_OWNERSHIPS, OWNERSHIP_LABELS } from '@/server/games/taxonomy';
import type { GameOwnership } from '@/server/games/taxonomy';
import { InlineEditField, InlineEditSelect } from './inline-edit-row';

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="space-y-1 border-t pt-4 first:border-t-0 first:pt-0">
      <h2 className="text-muted-foreground text-xs font-medium">{title}</h2>
      <div className="divide-y">{children}</div>
    </section>
  );
}

/**
 * The right column — Details/Progress/Notes, every field independently
 * inline-editable (`inline-edit-row.tsx`). Replaces the old whole-page
 * edit-mode form; `PageHeader`/`GameSummaryPanel` already carry the title
 * and Platform/Status/Rating/Hours/Platinum, so none of those repeat here.
 */
export function GameDetailsContent({
  ownership,
  priceCents,
  genre,
  developer,
  publisher,
  firstPlayedYear,
  achievementsUnlocked,
  achievementsTotal,
  steamOwned,
  notes,
  hoursTenths,
  playYears,
  onSaveField,
  onSavePlayYears,
}: {
  readonly ownership: GameOwnership | null;
  readonly priceCents: number | null;
  readonly genre: string | null;
  readonly developer: string | null;
  readonly publisher: string | null;
  readonly firstPlayedYear: number | null;
  readonly achievementsUnlocked: number | null;
  readonly achievementsTotal: number | null;
  readonly steamOwned: boolean;
  readonly notes: string | null;
  readonly hoursTenths: number | null;
  readonly playYears: readonly { readonly year: number; readonly hoursTenths: number }[];
  readonly onSaveField: (field: GameFieldKey, value: string) => Promise<ActionResult>;
  readonly onSavePlayYears: (drafts: readonly PlayYearDraft[]) => Promise<ActionResult>;
}): React.ReactElement {
  return (
    <div className="space-y-4">
      <Section title="Details">
        <InlineEditSelect
          label="Ownership"
          value={ownership ?? ''}
          displayValue={ownership === null ? '' : OWNERSHIP_LABELS[ownership]}
          options={[
            { value: '', label: 'Not set' },
            ...GAME_OWNERSHIPS.map((value) => ({ value, label: OWNERSHIP_LABELS[value] })),
          ]}
          onSave={(value) => onSaveField('ownership', value)}
        />
        <InlineEditField
          label="Price paid"
          value={priceCents === null ? '' : (priceCents / 100).toFixed(2)}
          displayValue={priceCents === null ? undefined : `$${(priceCents / 100).toFixed(2)}`}
          onSave={(value) => onSaveField('priceDollars', value)}
        />
        <InlineEditField label="Genre" value={genre ?? ''} onSave={(value) => onSaveField('genre', value)} />
        <InlineEditField
          label="Developer"
          value={developer ?? ''}
          onSave={(value) => onSaveField('developer', value)}
        />
        <InlineEditField
          label="Publisher"
          value={publisher ?? ''}
          onSave={(value) => onSaveField('publisher', value)}
        />
      </Section>

      <Section title="Progress">
        <InlineEditField
          label="First played"
          value={firstPlayedYear === null ? '' : String(firstPlayedYear)}
          placeholder="Not set"
          onSave={(value) => onSaveField('firstPlayedYear', value)}
        />
        <InlineEditField
          label="Achievements earned"
          value={achievementsUnlocked === null ? '' : String(achievementsUnlocked)}
          placeholder="Not tracked"
          disabled={steamOwned}
          disabledHint="From Steam"
          onSave={(value) => onSaveField('achievementsUnlocked', value)}
        />
        <InlineEditField
          label="Achievements total"
          value={achievementsTotal === null ? '' : String(achievementsTotal)}
          placeholder="Not tracked"
          disabled={steamOwned}
          disabledHint="From Steam"
          onSave={(value) => onSaveField('achievementsTotal', value)}
        />
        <PlayYearsRow hoursTenths={hoursTenths} playYears={playYears} onSave={onSavePlayYears} />
      </Section>

      <Section title="Notes">
        <InlineEditField
          label="Notes"
          value={notes ?? ''}
          placeholder="No notes yet — click to add some."
          multiline
          onSave={(value) => onSaveField('notes', value)}
        />
      </Section>
    </div>
  );
}

/**
 * The one field that isn't a scalar (an array of {year, hours} rows), so it
 * doesn't fit `InlineEditField`/`InlineEditSelect` — kept close to its old
 * shape: a toggle reveals `PlayYearsPanel`, edits stay local drafts while
 * open, one explicit save commits the whole split at once (still far
 * lighter than the old whole-PAGE save, and used by only the ~3 games out
 * of 160 that track a split at all).
 */
function PlayYearsRow({
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
      <Button type="button" size="sm" className="mt-2" disabled={saving} onClick={() => void save()}>
        {saving ? 'Saving…' : 'Save split'}
      </Button>
    </div>
  );
}
