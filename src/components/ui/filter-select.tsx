import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { FilterField } from './filter-bar';

/**
 * A labelled dropdown filter. Deduplicated: this exact component existed
 * privately in BOTH `finance/transactions/transactions-table.tsx` and
 * `finance/review/review-queue.tsx`, which is how they drifted to different
 * widths (`w-44` vs `w-48`) for the same control.
 *
 * One default width for every filter select in the app. `width` exists only
 * for the genuinely-wider cases (a category list with long names) — reach
 * for it rarely, or the ad-hoc-widths problem comes straight back.
 *
 * Height is deliberately NOT set here: `SelectTrigger`'s own default is the
 * shared control height, and every filter control in the app is now that
 * height because none of them override it any more.
 */
export function FilterSelect({
  label,
  value,
  onChange,
  options,
  width,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly (readonly [string, string])[];
  readonly width?: string;
}): React.ReactElement {
  return (
    <FilterField label={label}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label} className={cn('w-44', width)}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([optionValue, optionLabel]) => (
            <SelectItem key={optionValue} value={optionValue}>
              {optionLabel}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FilterField>
  );
}
