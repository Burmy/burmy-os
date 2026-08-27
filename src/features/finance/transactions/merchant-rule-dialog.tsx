'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { Money } from '@/components/finance/money';
import { formatHumanDate } from '@/lib/format-date';
import type { MerchantRulePreview } from '@/server/db/finance/transactions';
import { applyMerchantRuleAction } from './actions';

/**
 * "You just filed this merchant somewhere — should its other transactions
 * follow?"
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS.
 *
 * A categorization decision used to apply only FORWARD: `finance_merchant_memory`
 * teaches the next import, and does nothing about the rows already sitting in
 * the wrong place. The result, in real data, was ~19% of all spending parked in
 * "Other" — $24k across 190 transactions, including five Steam charges while a
 * "Gaming" category sat almost empty — because fixing it meant editing every
 * row by hand and doing it again next month.
 *
 * THE TWO LISTS ARE THE WHOLE SAFETY MODEL. "Apply to every transaction from
 * this merchant" sounds unambiguous and is not: BUC-EE'S is legitimately Food
 * AND Gas, and 829 of 961 categorized rows were filed by hand. So rows with no
 * category — the ones this feature is FOR — arrive pre-ticked, and rows already
 * filed elsewhere are shown separately, unticked, with the category they would
 * lose named on each line. Nothing moves that the owner did not see first.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function MerchantRuleDialog({
  preview,
  categoryId,
  categoryName,
  onClose,
}: {
  /** `null` closes the dialog — the parent clears it once the offer is dismissed or applied. */
  readonly preview: MerchantRulePreview | null;
  readonly categoryId: string;
  readonly categoryName: string;
  readonly onClose: () => void;
}): React.ReactElement | null {
  // Keyed on the merchant so re-opening for a DIFFERENT merchant starts from
  // the safe default rather than inheriting the last merchant's opt-ins.
  const [conflictIds, setConflictIds] = useState<ReadonlySet<string>>(new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (preview === null) return null;

  if (selectedKey !== preview.merchantKey) {
    setSelectedKey(preview.merchantKey);
    setConflictIds(new Set());
  }

  const ids = [...preview.willMove.map((row) => row.id), ...conflictIds];

  async function apply(): Promise<void> {
    setPending(true);
    const result = await applyMerchantRuleAction(ids, categoryId);
    setPending(false);

    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(
      `${result.updatedCount} transaction${result.updatedCount === 1 ? '' : 's'} moved to ${categoryName}`,
    );
    onClose();
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {preview.normalizedMerchant} → {categoryName}
          </DialogTitle>
          <DialogDescription>
            Future imports from this merchant will go to {categoryName} either way. This also re-files the transactions
            you already have.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[26rem] space-y-6 overflow-y-auto">
          <MatchList
            heading={`Will move (${preview.willMove.length})`}
            hint="Uncategorized, or in the category you just moved this one out of."
            rows={preview.willMove}
            checked={() => true}
            // Not togglable: these are either uncategorized or in the exact
            // category the owner just corrected away from, so there is no
            // decision of theirs to lose and a checkbox would imply a risk
            // that isn't there.
            onToggle={null}
          />

          {preview.conflicting.length === 0 ? null : (
            <MatchList
              heading={`Already categorized (${preview.conflicting.length})`}
              hint="Left alone unless you tick them — each is filed somewhere unrelated to this change."
              rows={preview.conflicting}
              checked={(id) => conflictIds.has(id)}
              onToggle={(id, next) =>
                setConflictIds((prev) => {
                  const updated = new Set(prev);
                  if (next) updated.add(id);
                  else updated.delete(id);
                  return updated;
                })
              }
            />
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Not now
          </Button>
          <Button type="button" onClick={() => void apply()} disabled={pending || ids.length === 0}>
            {pending ? 'Applying…' : `Move ${ids.length} transaction${ids.length === 1 ? '' : 's'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MatchList({
  heading,
  hint,
  rows,
  checked,
  onToggle,
}: {
  readonly heading: string;
  readonly hint: string;
  readonly rows: MerchantRulePreview['willMove'];
  readonly checked: (id: string) => boolean;
  /** `null` renders the list read-only — see the "Will move" call site. */
  readonly onToggle: ((id: string, next: boolean) => void) | null;
}): React.ReactElement {
  return (
    <div>
      <h3 className="text-sm font-medium">{heading}</h3>
      <p className="text-muted-foreground text-xs">{hint}</p>
      <ul className="mt-3 space-y-1">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center gap-3 text-sm">
            {onToggle === null ? null : (
              <Checkbox
                checked={checked(row.id)}
                onCheckedChange={(next) => onToggle(row.id, next === true)}
                aria-label={`Also move ${row.originalDescription}`}
              />
            )}
            <span className="text-muted-foreground shrink-0 text-xs">{formatHumanDate(row.transactionDate)}</span>
            <span className="min-w-0 flex-1 truncate">{row.originalDescription}</span>
            {row.categoryName === null ? null : (
              <span className="text-muted-foreground shrink-0 text-xs">{row.categoryName}</span>
            )}
            <span className="shrink-0">
              <Money valueCents={row.amountCents} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
