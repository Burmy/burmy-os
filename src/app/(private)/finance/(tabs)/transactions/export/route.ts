import { parseLedgerFilters } from '@/features/finance/transactions/filters';
import { requireOwner, toAuthErrorResponse } from '@/server/auth/owner';
import {
  LEDGER_EXPORT_ROW_LIMIT,
  listTransactionsForExport,
} from '@/server/db/finance/transactions';
import { TRANSACTION_TYPE_LABELS } from '@/server/finance/classify/manual';
import { buildTransactionsCsv, humanizeEnum, type LedgerExportRow } from '@/server/finance/export/csv';

export const dynamic = 'force-dynamic';

/**
 * CSV export of the transaction ledger — GET, not a Server Action, so a
 * plain `<a href>` gives the browser a native download with no client-side
 * Blob/ObjectURL plumbing. Layouts do not guard Route Handlers (Next.js
 * documents Server Functions/Route Handlers as their own entry points), so
 * `requireOwner()` runs here directly — the same rule every other protected
 * entry point in this app follows, enforced by
 * tests/integration/entry-points.test.ts.
 *
 * Reads filters through the exact same `parseLedgerFilters()` the page uses,
 * from the exact same query string the page's own export link builds (with
 * `page` stripped) — so "the export reflects the current filter" holds by
 * construction, not by two parsers happening to agree.
 */
export async function GET(request: Request): Promise<Response> {
  let ownerId: string;
  try {
    ownerId = (await requireOwner()).userId;
  } catch (error) {
    const response = toAuthErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const url = new URL(request.url);
  const raw: {
    year?: string;
    month?: string;
    category?: string;
    type?: string;
    status?: string;
    q?: string;
  } = {};
  const setIfPresent = (key: keyof typeof raw, param: string) => {
    const value = url.searchParams.get(param);
    if (value) raw[key] = value;
  };
  setIfPresent('year', 'year');
  setIfPresent('month', 'month');
  setIfPresent('category', 'category');
  setIfPresent('type', 'type');
  setIfPresent('status', 'status');
  setIfPresent('q', 'q');

  const currentYear = new Date().getUTCFullYear();
  const { filters } = parseLedgerFilters(raw, currentYear);

  const { rows, exceedsLimit } = await listTransactionsForExport(ownerId, filters);

  if (exceedsLimit) {
    return new Response(
      `This filter matches more than ${LEDGER_EXPORT_ROW_LIMIT} transactions and cannot be exported ` +
        'in one file. Narrow the date range, category, or type and try again.',
      { status: 413, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } },
    );
  }

  const exportRows: LedgerExportRow[] = rows.map((row) => ({
    transactionDate: row.transactionDate,
    normalizedMerchant: row.normalizedMerchant,
    originalDescription: row.originalDescription,
    amountCents: row.amountCents,
    categoryName: row.categoryName,
    transactionTypeLabel: TRANSACTION_TYPE_LABELS[row.transactionType] ?? row.transactionType,
    reviewStatusLabel: humanizeEnum(row.reviewStatus),
    categorizationSourceLabel: row.categorizationSource ? humanizeEnum(row.categorizationSource) : null,
    typeSourceLabel: humanizeEnum(row.typeSource),
  }));

  const csv = buildTransactionsCsv(exportRows);

  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="burmy-transactions-${filters.year}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
