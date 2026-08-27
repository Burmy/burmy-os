'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import type { ActionResult } from '@/features/games/action-result';
import type { GameFieldKey } from '@/features/games/game-actions';
import {
  isRealPlayYearDraft,
  PlayYearsPanel,
  type PlayYearDraft,
} from '@/features/games/play-years-panel';
import { GAME_OWNERSHIPS, OWNERSHIP_LABELS } from '@/server/games/taxonomy';
import type { GameOwnership } from '@/server/games/taxonomy';
import { InlineEditField, InlineEditSelect } from './inline-edit-row';

/**
 * A group of related rows, separated from the previous group by a rule.
 *
 * It used to carry a heading — "Details", "Progress", "Notes". All three were
 * removed: the rule already does the separating, every row inside is
 * self-labelled, and "Notes" in particular was a heading sitting directly on
 * top of a row whose own label was also "Notes". A one-word category name
 * above a list of labelled fields is a table of contents for four lines.
 *
 * It also used to carry `divide-y`, putting a rule under EVERY row — ten of
 * them stacked up on a page with nine fields. Those rules existed to bind a
 * label to a value that sat a full column-width away; now that
 * `inline-edit-row.tsx` puts the value directly beside its label, alignment
 * does that job and the rules were only noise. The group separators stay.
 */
/**
 * TWO COLUMNS from `lg`, one below it.
 *
 * These rows used to stack one per line inside a column capped at 672px, which
 * left ~360px of the page — a quarter of its width — permanently empty while
 * the fields ran nine rows deep. Splitting them across two columns spends that
 * width and halves the vertical run, WITHOUT reopening the problem the cap was
 * there to solve: each label still sits directly beside its own value, because
 * each column is only ~490px wide rather than the full 1000px.
 *
 * `gap-x-8` rather than the usual 16px: two columns of label/value pairs need a
 * visibly wider gutter than the gap between a label and its own value, or the
 * eye reads across the boundary and pairs the wrong two.
 */
function Section({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  return (
    <section className="grid gap-x-8 border-t pt-4 first:border-t-0 first:pt-0 lg:grid-cols-2">{children}</section>
  );
}

/**
 * A row that must span the full width rather than sit in one column — the notes
 * textarea, and the play-year split panel. Both are genuinely wide controls, not
 * label/value pairs, and squeezing either into half the row makes it unusable.
 */
function FullWidthRow({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  return <div className="lg:col-span-2">{children}</div>;
}

/**
 * The right column — every field independently
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
      <Section>
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
        <InlineEditField
          label="Genre"
          value={genre ?? ''}
          onSave={(value) => onSaveField('genre', value)}
        />
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

      <Section>
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
        <FullWidthRow>
          <PlayYearsRow hoursTenths={hoursTenths} playYears={playYears} onSave={onSavePlayYears} />
        </FullWidthRow>
      </Section>

      <Section>
        <FullWidthRow>
          <InlineEditField
            label="Notes"
            value={notes ?? ''}
            placeholder="No notes yet — click to add some."
            multiline
            onSave={(value) => onSaveField('notes', value)}
          />
        </FullWidthRow>
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
