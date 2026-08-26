import { isRealPlayYearDraft, type PlayYearDraft } from '@/features/games/play-years-panel';
import { formatHours, fromHoursInput } from '@/server/games/hours';
import { OWNERSHIP_LABELS } from '@/server/games/taxonomy';
import type { GameOwnership } from '@/server/games/taxonomy';

function Row({ label, value }: { readonly label: string; readonly value: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

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
 * The right column's read-only default — plain formatted text/labels, no
 * inputs anywhere. `game-page.tsx`'s `PageHeader` already carries the
 * title and `GameSummaryPanel` already carries Platform/Status/Rating/
 * Hours/Platinum, so neither repeats here — this only covers what's left:
 * the Details/Progress/Notes fields that used to live in the tabbed form.
 */
export function GameViewContent({
  ownership,
  priceDollars,
  genre,
  developer,
  publisher,
  firstPlayedYear,
  achievementsUnlocked,
  achievementsTotal,
  playYears,
  notes,
}: {
  readonly ownership: GameOwnership | '';
  readonly priceDollars: string;
  readonly genre: string;
  readonly developer: string;
  readonly publisher: string;
  readonly firstPlayedYear: string;
  readonly achievementsUnlocked: string;
  readonly achievementsTotal: string;
  readonly playYears: readonly PlayYearDraft[];
  readonly notes: string;
}): React.ReactElement {
  const achievements =
    achievementsUnlocked.trim() === '' && achievementsTotal.trim() === ''
      ? null
      : `${achievementsUnlocked || '—'} / ${achievementsTotal || '—'}`;
  const realPlayYears = playYears.filter(isRealPlayYearDraft);

  return (
    <div className="space-y-4">
      <Section title="Details">
        <Row label="Ownership" value={ownership === '' ? 'Not set' : OWNERSHIP_LABELS[ownership]} />
        <Row label="Price paid" value={priceDollars === '' ? 'Not set' : `$${priceDollars}`} />
        <Row label="Genre" value={genre === '' ? 'Not set' : genre} />
        <Row label="Developer" value={developer === '' ? 'Not set' : developer} />
        <Row label="Publisher" value={publisher === '' ? 'Not set' : publisher} />
      </Section>

      <Section title="Progress">
        <Row label="First played" value={firstPlayedYear === '' ? 'Not set' : firstPlayedYear} />
        <Row label="Achievements" value={achievements ?? 'Not tracked'} />
        {realPlayYears.length === 0 ? null : (
          <Row
            label="By year"
            value={realPlayYears
              .map((row) => {
                const parsed = fromHoursInput(row.hours);
                return `${row.year || '—'}: ${parsed === null ? '—' : formatHours(parsed)}`;
              })
              .join(' · ')}
          />
        )}
      </Section>

      <Section title="Notes">
        {notes === '' ? (
          <p className="text-muted-foreground py-1.5 text-sm">No notes yet.</p>
        ) : (
          <p className="py-1.5 text-sm whitespace-pre-wrap">{notes}</p>
        )}
      </Section>
    </div>
  );
}
