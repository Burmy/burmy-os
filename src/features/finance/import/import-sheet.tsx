'use client';

import { FileUp } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import type { FinanceImportSummary } from '@/server/db/finance/imports';
import { uploadStatementAction } from './actions';

/**
 * Upload only — a short-lived step, not a review UI. Staging a file
 * immediately navigates to `/finance/import/[importId]` (the full-page
 * review, `review-table.tsx`), which is the one canonical place to preview,
 * edit, and commit an import. This Sheet used to render that review inline
 * in its own scrollable pane — a Table nested inside an `overflow-y-auto`
 * div, itself inside a fixed-height side panel — which is exactly the
 * nested-scroll problem the full-page route was built to avoid. Keeping
 * upload and review as two separate surfaces removes that nesting
 * structurally instead of trying to patch the Sheet's internal layout.
 *
 * No account picker: the account is resolved automatically from the file's
 * detected format (see `uploadStatementAction`) — there is nothing left for
 * the owner to choose or set up first, not even a one-time "quick start."
 */
export function ImportSheet({
  inProgressImports,
}: {
  readonly inProgressImports: readonly FinanceImportSummary[];
}): React.ReactElement {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  function handleOpenChange(next: boolean): void {
    if (next) setError(null);
    setOpen(next);
  }

  function stage(file: File): void {
    setError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set('file', file);
      const outcome = await uploadStatementAction(formData);
      if (!outcome.ok) {
        setError(outcome.error);
        return;
      }
      setOpen(false);
      router.push(`/finance/import/${outcome.importId}`);
    });
  }

  function handleFile(file: File): void {
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setError('Only .csv files are accepted.');
      return;
    }
    stage(file);
  }

  function onFileInputChange(event: React.ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    if (file) handleFile(file);
    event.target.value = '';
  }

  function onDrop(event: React.DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger asChild>
        <Button size="sm">
          <FileUp className="size-4" />
          Import statement
        </Button>
      </SheetTrigger>
      <SheetContent className="flex flex-col gap-0 sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Import statement</SheetTitle>
          <SheetDescription>
            Select or drag a Bank of America CSV. It is parsed in memory and never written to disk.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-4">
          <div className="space-y-6">
            <div
              onDragOver={(event) => event.preventDefault()}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') fileInputRef.current?.click();
              }}
              className="border-muted-foreground/25 hover:border-muted-foreground/50 hover:bg-muted/30 flex cursor-pointer flex-col items-center gap-2 rounded-md border-2 border-dashed p-10 text-center transition-colors"
            >
              <FileUp className="text-muted-foreground size-6" />
              <p className="text-sm font-medium">
                {pending ? 'Reading file…' : 'Drop a CSV here, or click to browse'}
              </p>
              <p className="text-muted-foreground text-xs">Bank of America checking, savings, or credit card export</p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              className="sr-only"
              aria-label="Statement file"
              onChange={onFileInputChange}
            />

            {error ? (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            ) : null}

            {inProgressImports.length > 0 ? (
              <div>
                <h2 className="text-sm font-semibold">Resume</h2>
                <p className="text-muted-foreground mt-1 text-xs">
                  Staged earlier, not yet imported — nothing here has touched your transaction history.
                </p>
                <ul className="mt-2 space-y-1">
                  {inProgressImports.map((imp) => (
                    <li key={imp.id}>
                      <Link
                        href={`/finance/import/${imp.id}`}
                        className="hover:bg-muted/50 flex items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors"
                      >
                        <span>{imp.originalFilename}</span>
                        <span className="text-muted-foreground text-xs">{imp.rowCount} rows</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
