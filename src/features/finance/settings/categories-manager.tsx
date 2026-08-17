'use client';

import { ArrowDown, ArrowUp, Archive, Pencil, Plus, RotateCcw } from 'lucide-react';
import { useOptimistic, useState, useTransition } from 'react';
import { toast } from '@/components/ui/toast';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { CategoryKind, FinanceCategory } from '@/server/db/finance/categories';
import { moveInOrder } from '@/server/finance/taxonomy';
import type { ActionResult } from './action-result';
import {
  archiveCategoryAction,
  createCategoryAction,
  reorderCategoriesAction,
  restoreCategoryAction,
  updateCategoryAction,
} from './category-actions';

const KIND_LABELS: Record<CategoryKind, string> = {
  spending: 'Spending',
  income: 'Income',
  investment: 'Investment',
};

/**
 * Categories.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REORDERING IS UP/DOWN BUTTONS, NOT DRAG-AND-DROP.
 *
 * Buttons are keyboard accessible by construction, need no dependency, and this
 * list is reordered a handful of times a year. `dnd-kit` would add ~30KB and a
 * pointer-event surface to solve a problem two buttons already solve — and it
 * would need bespoke keyboard handling to be usable at all.
 *
 * The order is applied optimistically so repeated clicks feel immediate, then the
 * FULL ordered id list is sent to the server, which renumbers densely in one
 * transaction. Sending "move X up" per click would let interleaved requests
 * produce duplicate sort orders.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function CategoriesManager({
  live,
  archived,
}: {
  readonly live: readonly FinanceCategory[];
  readonly archived: readonly FinanceCategory[];
}): React.ReactElement {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<FinanceCategory | null>(null);
  const [pending, startTransition] = useTransition();

  /**
   * `useOptimistic` rather than `useState` seeded from props.
   *
   * The server is the source of truth — it renumbers and revalidates — so local
   * order is only a preview held for the duration of the request. `useOptimistic`
   * reverts to the server value automatically when the transition settles, which
   * means a rejected reorder needs no manual rollback and a successful one needs
   * no reconciliation. Mirroring props into `useState` would need a
   * setState-during-render to stay in sync, and would silently keep a stale order
   * if the write failed.
   */
  const [order, previewOrder] = useOptimistic<
    readonly FinanceCategory[],
    readonly FinanceCategory[]
  >(live, (_current, next) => next);

  function move(index: number, delta: -1 | 1): void {
    // Bounds are checked HERE, not by comparing the result: `moveInOrder` always
    // returns a fresh array, so an identity check against it would never fire.
    const target = index + delta;
    if (target < 0 || target >= order.length) return;

    const next = moveInOrder(order, index, delta);

    startTransition(async () => {
      previewOrder(next);
      const result = await reorderCategoriesAction(next.map((c) => c.id));
      if (!result.ok) toast.error(result.error);
    });
  }

  function run(action: () => Promise<ActionResult>, success: string): void {
    startTransition(async () => {
      const result = await action();
      if (result.ok) toast.success(success);
      else toast.error(result.error);
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Categories</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            The row axis of the monthly grid. Merchant-shaped names are fine.
          </p>
        </div>

        <Dialog open={creating} onOpenChange={setCreating}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="size-4" />
              Add category
            </Button>
          </DialogTrigger>
          <CategoryDialog
            key={creating ? 'create-open' : 'create-closed'}
            title="Add category"
            category={null}
            onDone={() => setCreating(false)}
          />
        </Dialog>
      </div>

      {order.length === 0 ? (
        <p className="text-muted-foreground mt-8 text-sm">No categories yet.</p>
      ) : (
        <ul className="mt-6 divide-y border-t border-b">
          {order.map((category, index) => (
            <li key={category.id} className="flex items-center gap-3 py-2">
              <div className="flex flex-col">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  aria-label={`Move ${category.name} up`}
                  disabled={index === 0 || pending}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  aria-label={`Move ${category.name} down`}
                  disabled={index === order.length - 1 || pending}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown className="size-3.5" />
                </Button>
              </div>

              <span className="flex-1 text-sm font-medium">{category.name}</span>

              <span className="text-muted-foreground text-xs">{KIND_LABELS[category.kind]}</span>

              <Dialog
                open={editing?.id === category.id}
                onOpenChange={(open) => setEditing(open ? category : null)}
              >
                <DialogTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label={`Edit ${category.name}`}>
                    <Pencil className="size-4" />
                  </Button>
                </DialogTrigger>
                <CategoryDialog
                  key={`${category.id}-${editing?.id === category.id ? 'open' : 'closed'}`}
                  title={`Edit ${category.name}`}
                  category={category}
                  onDone={() => setEditing(null)}
                />
              </Dialog>

              <Button
                variant="ghost"
                size="icon"
                aria-label={`Archive ${category.name}`}
                disabled={pending}
                onClick={() =>
                  run(() => archiveCategoryAction(category.id), `${category.name} archived`)
                }
              >
                <Archive className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {archived.length > 0 ? (
        <section className="mt-12">
          <h2 className="text-muted-foreground text-xs font-semibold tracking-widest uppercase">
            Archived
          </h2>
          <p className="text-muted-foreground mt-2 text-sm">
            Kept so past transactions stay attributable. Their names are free to reuse.
          </p>
          <ul className="mt-3 divide-y border-t border-b">
            {archived.map((category) => (
              <li key={category.id} className="flex items-center gap-3 py-2">
                <span className="text-muted-foreground flex-1 text-sm">{category.name}</span>
                <span className="text-muted-foreground text-xs">{KIND_LABELS[category.kind]}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    run(() => restoreCategoryAction(category.id), `${category.name} restored`)
                  }
                >
                  <RotateCcw className="size-4" />
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function CategoryDialog({
  title,
  category,
  onDone,
}: {
  readonly title: string;
  readonly category: FinanceCategory | null;
  readonly onDone: () => void;
}): React.ReactElement {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [kind, setKind] = useState<CategoryKind>(category?.kind ?? 'spending');
  const [pending, startTransition] = useTransition();

  function submit(formData: FormData): void {
    // Radix Select does not post a native form value.
    formData.set('kind', kind);

    startTransition(async () => {
      const outcome = category
        ? await updateCategoryAction(category.id, formData)
        : await createCategoryAction(formData);

      setResult(outcome);
      if (outcome.ok) {
        toast.success(category ? 'Category updated' : 'Category added');
        onDone();
      }
    });
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          `kind` decides which grid section the row appears in, and whether it counts toward
          Expenses.
        </DialogDescription>
      </DialogHeader>

      <form action={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" defaultValue={category?.name ?? ''} required autoFocus />
          {result && !result.ok ? (
            <p role="alert" className="text-destructive text-sm">
              {result.error}
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="kind-trigger">Kind</Label>
          <Select value={kind} onValueChange={(value) => setKind(value as CategoryKind)}>
            <SelectTrigger id="kind-trigger">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(KIND_LABELS) as CategoryKind[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {KIND_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">
            Investments appear in the grid and in Total Outflow, but not in Expenses.
          </p>
        </div>

        <DialogFooter>
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
