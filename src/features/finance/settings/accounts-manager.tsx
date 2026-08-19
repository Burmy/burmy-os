'use client';

import { Pencil, Plus } from 'lucide-react';
import { useState, useTransition } from 'react';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { AccountType, FinanceAccount } from '@/server/db/finance/accounts';
import type { ActionResult } from './action-result';
import {
  createAccountAction,
  quickStartBoaAccountsAction,
  setAccountActiveAction,
  updateAccountAction,
} from './account-actions';

/**
 * Accounts, with a create/edit dialog.
 *
 * `cash` is absent from the type list on purpose: it exists in the database enum
 * from M1, but cash spending is explicitly not tracked in V1, so offering it would
 * invite data the importer cannot produce.
 */
const TYPE_LABELS: Record<AccountType, string> = {
  checking: 'Checking',
  savings: 'Savings',
  credit_card: 'Credit card',
  brokerage: 'Brokerage',
};

export function AccountsManager({
  accounts,
}: {
  readonly accounts: readonly FinanceAccount[];
}): React.ReactElement {
  const [editing, setEditing] = useState<FinanceAccount | null>(null);
  const [creating, setCreating] = useState(false);
  const [pending, startTransition] = useTransition();

  function toggleActive(account: FinanceAccount): void {
    startTransition(async () => {
      const result = await setAccountActiveAction(account.id, !account.isActive);
      if (!result.ok) toast.error(result.error);
    });
  }

  function quickStart(): void {
    startTransition(async () => {
      const result = await quickStartBoaAccountsAction();
      if (!result.ok) toast.error(result.error);
      else toast.success('BoA Checking and BoA Credit Card added');
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Accounts</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Your own labelling. Burmy never connects to a bank.
          </p>
        </div>

        <Dialog open={creating} onOpenChange={setCreating}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="size-4" />
              Add account
            </Button>
          </DialogTrigger>
          <AccountDialog
            key={creating ? 'create-open' : 'create-closed'}
            title="Add account"
            account={null}
            onDone={() => setCreating(false)}
          />
        </Dialog>
      </div>

      {accounts.length === 0 ? (
        <div className="mt-8 space-y-3">
          <p className="text-muted-foreground text-sm">No accounts yet.</p>
          <Button size="sm" variant="outline" disabled={pending} onClick={quickStart}>
            Set up Bank of America (Checking + Credit Card)
          </Button>
        </div>
      ) : (
        <Table className="mt-6">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Institution</TableHead>
              <TableHead>Last 4</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((account) => (
              <TableRow key={account.id} className={account.isActive ? undefined : 'opacity-50'}>
                <TableCell className="font-medium">{account.name}</TableCell>
                <TableCell>{TYPE_LABELS[account.type]}</TableCell>
                <TableCell className="text-muted-foreground">
                  {account.institution ?? '—'}
                </TableCell>
                <TableCell className="tabular">{account.lastFour ?? '—'}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Dialog
                      open={editing?.id === account.id}
                      onOpenChange={(open) => setEditing(open ? account : null)}
                    >
                      <DialogTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label={`Edit ${account.name}`}>
                          <Pencil className="size-4" />
                        </Button>
                      </DialogTrigger>
                      <AccountDialog
                        key={`${account.id}-${editing?.id === account.id ? 'open' : 'closed'}`}
                        title={`Edit ${account.name}`}
                        account={account}
                        onDone={() => setEditing(null)}
                      />
                    </Dialog>

                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => toggleActive(account)}
                    >
                      {account.isActive ? 'Deactivate' : 'Reactivate'}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function AccountDialog({
  title,
  account,
  onDone,
}: {
  readonly title: string;
  readonly account: FinanceAccount | null;
  readonly onDone: () => void;
}): React.ReactElement {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [type, setType] = useState<AccountType>(account?.type ?? 'checking');
  const [pending, startTransition] = useTransition();

  function submit(formData: FormData): void {
    // The Select is a Radix component and does not post a native form value.
    formData.set('type', type);

    startTransition(async () => {
      const outcome = account
        ? await updateAccountAction(account.id, formData)
        : await createAccountAction(formData);

      setResult(outcome);
      if (outcome.ok) {
        toast.success(account ? 'Account updated' : 'Account added');
        onDone();
      }
    });
  }

  const fieldError = (field: 'name' | 'lastFour'): string | null =>
    result && !result.ok && result.field === field ? result.error : null;

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          Only the last four digits are ever stored — never a full account number.
        </DialogDescription>
      </DialogHeader>

      <form action={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" defaultValue={account?.name ?? ''} required autoFocus />
          {fieldError('name') ? (
            <p role="alert" className="text-destructive text-sm">
              {fieldError('name')}
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="type-trigger">Type</Label>
          <Select value={type} onValueChange={(value) => setType(value as AccountType)}>
            <SelectTrigger id="type-trigger">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(TYPE_LABELS) as AccountType[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {TYPE_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="institution">Institution</Label>
          <Input
            id="institution"
            name="institution"
            defaultValue={account?.institution ?? ''}
            placeholder="Bank of America"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="lastFour">Last 4 digits</Label>
          <Input
            id="lastFour"
            name="lastFour"
            defaultValue={account?.lastFour ?? ''}
            inputMode="numeric"
            maxLength={4}
            placeholder="Optional"
            className="tabular"
          />
          {fieldError('lastFour') ? (
            <p role="alert" className="text-destructive text-sm">
              {fieldError('lastFour')}
            </p>
          ) : null}
        </div>

        {result && !result.ok && !result.field ? (
          <p role="alert" className="text-destructive text-sm">
            {result.error}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
