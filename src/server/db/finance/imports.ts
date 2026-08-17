/**
 * Owner-scoped data access for the import pipeline: staging, preview, commit.
 *
 * Same rule as accounts.ts and categories.ts: `ownerId` is the first parameter
 * of every function and goes into every `WHERE`.
 *
 * The parsing and dedupe-key computation themselves are PURE (M4's `parse/` and
 * `dedupe.ts`, M5's `import/staging.ts` and `import/compatibility.ts`) and live
 * in `src/server/finance/`. This file is only the DB primitives that stage,
 * read, decide on, and commit what those pure functions produced — orchestrated
 * by `src/features/finance/import/actions.ts`.
 */

import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';

import { getDb } from '@/server/db';
import {
  financeImportFiles,
  financeImportRows,
  financeImports,
  financeTransactions,
} from '@/server/db/schema';
import { defaultTransactionType, planStagedDecisions } from '@/server/finance/import/staging';
import type { CommittedMatch } from '@/server/finance/import/staging';
import { fromDb } from '@/server/finance/money';
import type { AdapterId } from '@/server/finance/parse/types';
import { ImportNotReviewableError, NotFoundError } from './errors';

/** Enforced client-side too, but the server never trusts that. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * 60 days, not 7. Burmy is used monthly; a 7-day sweep would delete an
 * in-progress review before the owner ever returned to it.
 */
const EXPIRY_MS = 60 * 24 * 60 * 60 * 1000;

export type ImportStatus = (typeof financeImports.$inferSelect)['status'];
export type RowDecision = (typeof financeImportRows.$inferSelect)['decision'];

// ─────────────────────────────────────────────────────────────────────────────
// File-hash pre-check
// ─────────────────────────────────────────────────────────────────────────────

export interface PriorFileUpload {
  readonly importId: string;
  readonly status: ImportStatus;
  readonly committedAt: Date | null;
  readonly createdAt: Date;
}

/**
 * Has this exact file been seen before? The most RECENT match only — enough to
 * write one honest sentence, and the caller must not call it "already imported"
 * unless `status === 'committed'` (a `review` or `discarded` match was never
 * actually imported). See docs/FINANCE.md.
 */
export async function findPriorFileUpload(
  ownerId: string,
  fileSha256: string,
  excludeImportId?: string,
): Promise<PriorFileUpload | null> {
  const conditions = [eq(financeImports.ownerId, ownerId), eq(financeImportFiles.fileSha256, fileSha256)];
  if (excludeImportId) conditions.push(ne(financeImports.id, excludeImportId));

  const rows = await getDb()
    .select({
      importId: financeImports.id,
      status: financeImports.status,
      committedAt: financeImports.committedAt,
      createdAt: financeImports.createdAt,
    })
    .from(financeImportFiles)
    .innerJoin(financeImports, eq(financeImportFiles.importId, financeImports.id))
    .where(and(...conditions))
    .orderBy(desc(financeImports.createdAt))
    .limit(1);

  return rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 2 committed counts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many committed transactions already share each dedupe key.
 *
 * Called twice: once at staging (against `getDb()`) to compute the default
 * decisions, and again inside `commitImport()`'s transaction (against `tx`) to
 * re-check them immediately before inserting. The two call sites are written
 * separately rather than sharing a helper typed over both `Db` and a
 * transaction — Drizzle's transaction type does not collapse cleanly into a
 * small structural interface, and duplicating one ten-line query is cheaper
 * than fighting that.
 */
export async function getCommittedCounts(
  ownerId: string,
  keys: readonly string[],
): Promise<Map<string, CommittedMatch>> {
  if (keys.length === 0) return new Map();

  const rows = await getDb()
    .select({
      dedupeKey: financeTransactions.dedupeKey,
      count: sql<number>`count(*)::int`,
      // Postgres has no MIN aggregate for `uuid` — cast to text BEFORE min(),
      // not after, or the aggregate itself fails to resolve at all.
      sampleId: sql<string>`min(${financeTransactions.id}::text)`,
    })
    .from(financeTransactions)
    .where(and(eq(financeTransactions.ownerId, ownerId), inArray(financeTransactions.dedupeKey, keys)))
    .groupBy(financeTransactions.dedupeKey);

  return new Map(rows.map((row) => [row.dedupeKey, { count: row.count, sampleTransactionId: row.sampleId }]));
}

// ─────────────────────────────────────────────────────────────────────────────
// Staging
// ─────────────────────────────────────────────────────────────────────────────

export interface StageRowInput {
  readonly rowNumber: number;
  readonly transactionDate: string | null;
  readonly postedDate: string | null;
  readonly description: string | null;
  readonly amountCents: number | null;
  readonly detectedDirection: 'outflow' | 'inflow' | null;
  readonly sourceCategory: string | null;
  readonly sourceTransactionId: string | null;
  readonly normalizedMerchant: string | null;
  readonly merchantKey: string | null;
  readonly dedupeKey: string | null;
  readonly dedupeKeyVersion: number;
  readonly decision: RowDecision;
  readonly duplicateOfTransactionId: string | null;
  /** Set only for rows `parseStatementTolerant` could not normalize. */
  readonly parseError: string | null;
}

export interface StageImportInput {
  readonly accountId: string;
  readonly originalFilename: string;
  readonly fileSha256: string;
  readonly adapter: AdapterId;
  readonly rows: readonly StageRowInput[];
}

/**
 * Create the import, its one file, and every staged row in a single
 * transaction — an import with a file but no rows, or rows with no parent, is
 * a state nothing downstream should ever have to handle.
 */
export async function createStagedImport(
  ownerId: string,
  input: StageImportInput,
): Promise<{ readonly importId: string }> {
  const validDates = input.rows
    .map((row) => row.transactionDate)
    .filter((date): date is string => date !== null)
    .sort();

  const dateRangeStart = validDates[0] ?? null;
  const dateRangeEnd = validDates[validDates.length - 1] ?? null;
  const expiresAt = new Date(Date.now() + EXPIRY_MS);

  return getDb().transaction(async (tx) => {
    const [importRow] = await tx
      .insert(financeImports)
      .values({
        ownerId,
        status: 'review',
        rowCount: input.rows.length,
        dateRangeStart,
        dateRangeEnd,
        expiresAt,
      })
      .returning({ id: financeImports.id });
    if (!importRow) throw new Error('Import insert returned no row');

    const [fileRow] = await tx
      .insert(financeImportFiles)
      .values({
        importId: importRow.id,
        accountId: input.accountId,
        originalFilename: input.originalFilename,
        fileSha256: input.fileSha256,
        adapter: input.adapter,
        rowCount: input.rows.length,
      })
      .returning({ id: financeImportFiles.id });
    if (!fileRow) throw new Error('Import file insert returned no row');

    if (input.rows.length > 0) {
      await tx.insert(financeImportRows).values(
        input.rows.map((row) => ({
          importId: importRow.id,
          fileId: fileRow.id,
          rowNumber: row.rowNumber,
          transactionDate: row.transactionDate,
          postedDate: row.postedDate,
          description: row.description,
          amountCents: row.amountCents,
          detectedDirection: row.detectedDirection,
          sourceCategory: row.sourceCategory,
          sourceTransactionId: row.sourceTransactionId,
          normalizedMerchant: row.normalizedMerchant,
          merchantKey: row.merchantKey,
          dedupeKey: row.dedupeKey,
          dedupeKeyVersion: row.dedupeKeyVersion,
          duplicateOfTransactionId: row.duplicateOfTransactionId,
          // Tier 2 is the only reconciliation mechanism M5 has, so any flagged
          // duplicate is 'exact' — an exact dedupe-key match, never 'near' or
          // 'file' (the latter belongs to the file-hash pre-check, which never
          // writes to a row).
          duplicateKind: row.duplicateOfTransactionId ? ('exact' as const) : null,
          decision: row.decision,
          parseError: row.parseError,
        })),
      );
    }

    return { importId: importRow.id };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading — the in-progress list and the review page
// ─────────────────────────────────────────────────────────────────────────────

export interface FinanceImportSummary {
  readonly id: string;
  readonly status: ImportStatus;
  readonly rowCount: number;
  readonly dateRangeStart: string | null;
  readonly dateRangeEnd: string | null;
  readonly createdAt: Date;
  readonly committedAt: Date | null;
  readonly accountId: string;
  readonly originalFilename: string;
  /** For the review page's own prior-upload check — see `findPriorFileUpload`. */
  readonly fileSha256: string;
}

const SUMMARY_COLUMNS = {
  id: financeImports.id,
  status: financeImports.status,
  rowCount: financeImports.rowCount,
  dateRangeStart: financeImports.dateRangeStart,
  dateRangeEnd: financeImports.dateRangeEnd,
  createdAt: financeImports.createdAt,
  committedAt: financeImports.committedAt,
  accountId: financeImportFiles.accountId,
  originalFilename: financeImportFiles.originalFilename,
  fileSha256: financeImportFiles.fileSha256,
} as const;

export async function listInProgressImports(ownerId: string): Promise<FinanceImportSummary[]> {
  const rows = await getDb()
    .select(SUMMARY_COLUMNS)
    .from(financeImports)
    .innerJoin(financeImportFiles, eq(financeImportFiles.importId, financeImports.id))
    .where(and(eq(financeImports.ownerId, ownerId), eq(financeImports.status, 'review')))
    .orderBy(desc(financeImports.createdAt));

  // `accountId` is nullable in the schema (the file's account reference is
  // ON DELETE SET NULL), but M5 never leaves it unset at staging time and
  // accounts are never deleted — only deactivated. A row that somehow lost it
  // is excluded rather than shown with a broken account reference.
  return rows.filter((row): row is FinanceImportSummary => row.accountId !== null);
}

export async function getImportForOwner(
  ownerId: string,
  importId: string,
): Promise<FinanceImportSummary> {
  const rows = await getDb()
    .select(SUMMARY_COLUMNS)
    .from(financeImports)
    .innerJoin(financeImportFiles, eq(financeImportFiles.importId, financeImports.id))
    .where(and(eq(financeImports.ownerId, ownerId), eq(financeImports.id, importId)))
    .limit(1);

  const row = rows[0];
  if (!row || row.accountId === null) throw new NotFoundError('Import');
  return { ...row, accountId: row.accountId };
}

export interface FinanceImportRowView {
  readonly id: string;
  readonly rowNumber: number;
  readonly transactionDate: string | null;
  readonly postedDate: string | null;
  /** Verbatim from the statement — shown alongside the merchant so the owner can categorize from the real text. */
  readonly description: string | null;
  readonly normalizedMerchant: string | null;
  readonly amountCents: number | null;
  readonly sourceCategory: string | null;
  readonly decision: RowDecision;
  readonly decisionOverridden: boolean;
  readonly duplicateOfTransactionId: string | null;
  readonly categoryId: string | null;
  readonly parseError: string | null;
}

export async function getImportRows(
  ownerId: string,
  importId: string,
): Promise<FinanceImportRowView[]> {
  // Confirms ownership before reading a single row — an id belonging to
  // another owner (unreachable with one owner, but the shape matters) must
  // fail here, not leak rows.
  await getImportForOwner(ownerId, importId);

  const rows = await getDb()
    .select({
      id: financeImportRows.id,
      rowNumber: financeImportRows.rowNumber,
      transactionDate: financeImportRows.transactionDate,
      postedDate: financeImportRows.postedDate,
      description: financeImportRows.description,
      normalizedMerchant: financeImportRows.normalizedMerchant,
      amountCents: financeImportRows.amountCents,
      sourceCategory: financeImportRows.sourceCategory,
      decision: financeImportRows.decision,
      decisionOverridden: financeImportRows.decisionOverridden,
      duplicateOfTransactionId: financeImportRows.duplicateOfTransactionId,
      categoryId: financeImportRows.suggestedCategoryId,
      parseError: financeImportRows.parseError,
    })
    .from(financeImportRows)
    .where(eq(financeImportRows.importId, importId))
    .orderBy(asc(financeImportRows.rowNumber));

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Owner decisions — include/exclude and category, per row
// ─────────────────────────────────────────────────────────────────────────────

export interface RowDecisionUpdate {
  readonly decision?: 'include' | 'exclude';
  readonly categoryId?: string | null;
}

/**
 * Setting `decision` here is what marks the row `decisionOverridden` — the flag
 * `commitImport()` reads to decide whether a fresh Tier 2 re-check applies to
 * it. Setting only `categoryId` does not touch that flag.
 */
export async function updateRowDecision(
  ownerId: string,
  importId: string,
  rowId: string,
  update: RowDecisionUpdate,
): Promise<void> {
  const imp = await getImportForOwner(ownerId, importId);
  if (imp.status !== 'review') throw new ImportNotReviewableError(imp.status);

  const setValues: Partial<typeof financeImportRows.$inferInsert> = { updatedAt: new Date() };
  if (update.decision !== undefined) {
    setValues.decision = update.decision;
    setValues.decisionOverridden = true;
  }
  if ('categoryId' in update) {
    setValues.suggestedCategoryId = update.categoryId ?? null;
    setValues.categorizationSource = update.categoryId ? 'manual' : null;
  }

  const conditions = [eq(financeImportRows.id, rowId), eq(financeImportRows.importId, importId)];
  // A row with no valid amount/date (a parse failure) can never be included —
  // there is nothing to write to `finance_transactions`.
  if (update.decision === 'include') conditions.push(sql`${financeImportRows.parseError} is null`);

  const updated = await getDb()
    .update(financeImportRows)
    .set(setValues)
    .where(and(...conditions))
    .returning({ id: financeImportRows.id });

  if (updated.length === 0) throw new NotFoundError('Import row');
}

// ─────────────────────────────────────────────────────────────────────────────
// Commit
// ─────────────────────────────────────────────────────────────────────────────

export interface CommitResult {
  readonly importedCount: number;
  readonly skippedDuplicateCount: number;
  readonly skippedFailedCount: number;
  /**
   * Rows that WOULD have imported by the staging-time default, but a
   * concurrently committed import claimed the same dedupe key first. Surfaced
   * so the owner sees the count changed, rather than it silently differing
   * from what the preview showed.
   */
  readonly demotedByRaceCount: number;
}

/**
 * Commit every `include`d row into `finance_transactions`, atomically.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE ADVISORY LOCK
 *
 * Two imports staged around the same time can each see "0 committed" for the
 * same dedupe key and each default that row to `include` — correct at staging
 * time, wrong if both commit. Postgres's default READ COMMITTED isolation does
 * not catch this: two inserts of NEW rows never conflict with each other. A
 * `pg_advisory_xact_lock` keyed to the owner serializes commits for that owner,
 * so the second transaction's re-check (below) sees the first one's result
 * before it decides anything. Burmy has exactly one owner, so a per-owner lock
 * has no practical throughput cost — simpler to reason about than relying on
 * SERIALIZABLE isolation's write-skew detection for the same guarantee.
 *
 * WHY OVERRIDDEN ROWS SKIP THE RE-CHECK
 *
 * A row the owner explicitly flipped to Include (a genuine same-day repeat the
 * default excluded) is honoured as-is, unconditionally. Only rows still
 * following the staging-time default are re-reconciled against the CURRENT
 * committed count — see the `decisionOverridden` column comment in schema.ts.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export async function commitImport(ownerId: string, importId: string): Promise<CommitResult> {
  return getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('burmy_import_commit'), hashtext(${ownerId}))`,
    );

    const [imp] = await tx
      .select({
        id: financeImports.id,
        status: financeImports.status,
        accountId: financeImportFiles.accountId,
      })
      .from(financeImports)
      .innerJoin(financeImportFiles, eq(financeImportFiles.importId, financeImports.id))
      .where(and(eq(financeImports.ownerId, ownerId), eq(financeImports.id, importId)))
      .limit(1);

    if (!imp) throw new NotFoundError('Import');
    if (imp.status !== 'review') throw new ImportNotReviewableError(imp.status);
    if (!imp.accountId) throw new Error('Import has no associated account');
    const accountId = imp.accountId;

    const rows = await tx
      .select()
      .from(financeImportRows)
      .where(eq(financeImportRows.importId, importId));

    const failedCount = rows.filter((row) => row.parseError !== null).length;
    const overriddenInclude = rows.filter(
      (row) => row.parseError === null && row.decisionOverridden && row.decision === 'include',
    );
    const natural = rows.filter((row) => row.parseError === null && !row.decisionOverridden);

    const naturalKeys = [...new Set(natural.map((row) => row.dedupeKey).filter((key): key is string => key !== null))];

    const freshCommitted = new Map<string, CommittedMatch>();
    if (naturalKeys.length > 0) {
      const committedRows = await tx
        .select({
          dedupeKey: financeTransactions.dedupeKey,
          count: sql<number>`count(*)::int`,
          // Postgres has no MIN aggregate for `uuid` — cast to text BEFORE min(),
      // not after, or the aggregate itself fails to resolve at all.
      sampleId: sql<string>`min(${financeTransactions.id}::text)`,
        })
        .from(financeTransactions)
        .where(
          and(eq(financeTransactions.ownerId, ownerId), inArray(financeTransactions.dedupeKey, naturalKeys)),
        )
        .groupBy(financeTransactions.dedupeKey);

      for (const row of committedRows) {
        freshCommitted.set(row.dedupeKey, { count: row.count, sampleTransactionId: row.sampleId });
      }
    }

    const freshDecisions = planStagedDecisions(
      natural
        .filter((row) => row.dedupeKey !== null)
        .map((row) => ({ rowNumber: row.rowNumber, dedupeKey: row.dedupeKey! })),
      freshCommitted,
    );
    const freshByRowNumber = new Map(freshDecisions.map((decision) => [decision.rowNumber, decision]));

    let demotedByRaceCount = 0;
    const naturalInclude: (typeof rows)[number][] = [];

    for (const row of natural) {
      const fresh = row.dedupeKey ? freshByRowNumber.get(row.rowNumber) : undefined;
      const nowIncluded = fresh?.decision === 'include';

      if (nowIncluded) naturalInclude.push(row);
      else if (row.decision === 'include') demotedByRaceCount += 1;

      if (fresh && fresh.decision !== row.decision) {
        await tx
          .update(financeImportRows)
          .set({ decision: fresh.decision, updatedAt: new Date() })
          .where(eq(financeImportRows.id, row.id));
      }
    }

    const toInsert = [...overriddenInclude, ...naturalInclude];

    if (toInsert.length > 0) {
      await tx.insert(financeTransactions).values(
        toInsert.map((row) => ({
          ownerId,
          accountId,
          importId,
          transactionDate: row.transactionDate!,
          postedDate: row.postedDate,
          originalDescription: row.description!,
          normalizedMerchant: row.normalizedMerchant,
          amountCents: row.amountCents!,
          transactionType: defaultTransactionType(fromDb(row.amountCents)),
          categoryId: row.suggestedCategoryId,
          sourceTransactionId: row.sourceTransactionId,
          reviewStatus: row.suggestedCategoryId ? ('confirmed' as const) : ('needs_review' as const),
          categorizationSource: row.suggestedCategoryId ? ('manual' as const) : null,
          typeSource: 'default' as const,
          dedupeKey: row.dedupeKey!,
          dedupeKeyVersion: row.dedupeKeyVersion,
        })),
      );
    }

    await tx
      .update(financeImports)
      .set({ status: 'committed', committedAt: new Date(), updatedAt: new Date() })
      .where(eq(financeImports.id, importId));

    return {
      importedCount: toInsert.length,
      skippedDuplicateCount: rows.length - toInsert.length - failedCount,
      skippedFailedCount: failedCount,
      demotedByRaceCount,
    };
  });
}

export async function discardImport(ownerId: string, importId: string): Promise<void> {
  const imp = await getImportForOwner(ownerId, importId);
  if (imp.status !== 'review') throw new ImportNotReviewableError(imp.status);

  await getDb()
    .update(financeImports)
    .set({ status: 'discarded', updatedAt: new Date() })
    .where(and(eq(financeImports.ownerId, ownerId), eq(financeImports.id, importId)));
}
