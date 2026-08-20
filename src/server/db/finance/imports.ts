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

import { and, asc, desc, eq, gte, ilike, inArray, lte, ne, sql } from 'drizzle-orm';

import { getDb } from '@/server/db';
import type { AccountType } from '@/server/db/finance/accounts';
import {
  financeAccounts,
  financeImportFiles,
  financeImportRows,
  financeImports,
  financeMerchantMemory,
  financeTransactions,
} from '@/server/db/schema';
import {
  COUNTERPART_WINDOW_DAYS,
  type QualifiedCounterpart,
  dateWindow,
  extractConfirmationToken,
  findQualifyingCounterpart,
  isKnownCardPaymentReceived,
} from '@/server/finance/classify/counterpart';
import { type ManualTransactionType, reviewStatusForCorrection } from '@/server/finance/classify/manual';
import {
  defaultTransactionType,
  planStagedDecisions,
  reviewStatusFor,
} from '@/server/finance/import/staging';
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

/**
 * Staging-time PREVIEW only — `commitImport()` re-derives this for real
 * inside its own transaction and is authoritative. A second copy of the
 * candidate query (against `getDb()`, not a tx) rather than a shared helper —
 * see `getCommittedCounts()`'s comment above for why tx/non-tx query code
 * stays duplicated in this file. If the WHERE clause here changes, change it
 * in `commitImport()`'s matching loop too.
 *
 * Falls back to `isKnownCardPaymentReceived()` when no committed counterpart
 * exists yet (e.g. the card statement is being imported before its matching
 * checking statement) — same fallback `commitImport()` itself applies at
 * commit, so the preview and the eventual real classification agree.
 */
export async function previewCounterpartType(
  ownerId: string,
  accountId: string,
  accountType: AccountType,
  description: string,
  transactionDate: string,
  amountCents: number,
): Promise<'transfer' | 'credit_card_payment' | null> {
  const token = extractConfirmationToken(description);
  if (!token) return null;

  const { start, end } = dateWindow(transactionDate, COUNTERPART_WINDOW_DAYS);

  const candidates = await getDb()
    .select({
      id: financeTransactions.id,
      amountCents: financeTransactions.amountCents,
      description: financeTransactions.originalDescription,
      accountType: financeAccounts.type,
    })
    .from(financeTransactions)
    .innerJoin(financeAccounts, eq(financeAccounts.id, financeTransactions.accountId))
    .where(
      and(
        eq(financeTransactions.ownerId, ownerId),
        eq(financeTransactions.typeSource, 'default'),
        ne(financeTransactions.accountId, accountId),
        gte(financeTransactions.transactionDate, start),
        lte(financeTransactions.transactionDate, end),
        ilike(financeTransactions.originalDescription, `%${token}%`),
      ),
    );

  const match = findQualifyingCounterpart(token, amountCents, accountType, candidates);
  if (match) return match.transactionType;

  return isKnownCardPaymentReceived(accountType, description, amountCents) ? 'credit_card_payment' : null;
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
  /** M6: from merchant memory at staging, or the owner's own pick via `updateRowDecision`. */
  readonly suggestedCategoryId: string | null;
  readonly categorizationSource: 'manual' | 'merchant_memory' | null;
  /** `previewCounterpartType()`'s staging-time guess, or the owner's own override — see `typeOverridden`. */
  readonly suggestedType: 'transfer' | 'credit_card_payment' | null;
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
          suggestedCategoryId: row.suggestedCategoryId,
          categorizationSource: row.categorizationSource,
          suggestedType: row.suggestedType,
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
  /** Distinguishes an owner's own pick from a merchant-memory suggestion left untouched — see `reviewStatusFor`. */
  readonly categorizationSource: 'manual' | 'merchant_memory' | null;
  readonly suggestedType: 'transfer' | 'credit_card_payment' | null;
  readonly typeOverridden: boolean;
  readonly reviewNote: string | null;
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
      categorizationSource: financeImportRows.categorizationSource,
      suggestedType: financeImportRows.suggestedType,
      typeOverridden: financeImportRows.typeOverridden,
      reviewNote: financeImportRows.reviewNote,
      parseError: financeImportRows.parseError,
    })
    .from(financeImportRows)
    .where(eq(financeImportRows.importId, importId))
    .orderBy(asc(financeImportRows.rowNumber));

  // Narrowed by construction: staging.ts/updateRowDecision never write
  // anything else into either column — same reasoning as commitImport()'s
  // own cast below.
  return rows.map((row) => ({
    ...row,
    categorizationSource: row.categorizationSource as 'manual' | 'merchant_memory' | null,
    suggestedType: row.suggestedType as 'transfer' | 'credit_card_payment' | null,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Owner decisions — include/exclude and category, per row
// ─────────────────────────────────────────────────────────────────────────────

export interface RowDecisionUpdate {
  readonly decision?: 'include' | 'exclude';
  readonly categoryId?: string | null;
  /** Display-name correction only — never touches `dedupeKey` (derived from `description`) or `merchantKey`. */
  readonly normalizedMerchant?: string;
  readonly reviewNote?: string | null;
  /**
   * The owner's own type pick, made during import review before commit — sets
   * `typeOverridden`, exactly mirroring `decision`/`decisionOverridden`. A
   * `null` value here is not meaningful (there is no "un-pick" for a type the
   * way there is for a note) so this is never sent as `null`; the type only
   * ever narrows further, same as `decision`.
   */
  readonly typeOverride?: ManualTransactionType;
}

/**
 * Setting `decision` here is what marks the row `decisionOverridden` — the flag
 * `commitImport()` reads to decide whether a fresh Tier 2 re-check applies to
 * it. Setting only `categoryId` does not touch that flag. Setting
 * `typeOverride` marks `typeOverridden` the same way, for the same reason:
 * `commitImport()` must never let its own auto-classification silently
 * replace an owner's explicit pre-commit pick.
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
  if (update.normalizedMerchant !== undefined) {
    const trimmed = update.normalizedMerchant.trim();
    setValues.normalizedMerchant = trimmed === '' ? null : trimmed;
  }
  if ('reviewNote' in update) {
    const trimmed = update.reviewNote?.trim() ?? null;
    setValues.reviewNote = trimmed === '' ? null : trimmed;
  }
  if (update.typeOverride !== undefined) {
    setValues.suggestedType = update.typeOverride;
    setValues.typeOverridden = true;
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
  /**
   * Rows that required zero manual input: a category from merchant memory, a
   * counterpart match, or both. M6's whole point, made visible.
   */
  readonly autoClassifiedCount: number;
}

/**
 * Type/review-status precedence for one row about to be inserted, in order:
 * an owner's own pre-commit pick (`typeOverridden`) is authoritative and
 * skips everything else; then a real cross-account counterpart match (found
 * by the loop above); then the narrow local BoA card-payment pattern (see
 * `isKnownCardPaymentReceived`); then the plain sign-based default. Only the
 * override and match paths get a `typeSource` that blocks future automation
 * — the pattern fallback deliberately stays `'default'` so a real
 * counterpart, once it exists, can still link this row for real later (it
 * looks identical to any other unmatched `type_source = 'default'` row to
 * that query).
 */
function classifyRow(
  row: typeof financeImportRows.$inferSelect,
  // The wider, Drizzle-inferred enum (matches `financeAccounts.type` as
  // actually selected in `commitImport()`) — not the narrower `AccountType`
  // from `db/finance/accounts`, which excludes `cash` and is only ever
  // reachable via manual entry, never an import.
  accountType: 'checking' | 'savings' | 'credit_card' | 'brokerage' | 'cash',
  match: QualifiedCounterpart | undefined,
  categoryId: string | null,
  categorizationSource: 'manual' | 'merchant_memory' | null,
): {
  readonly transactionType: ManualTransactionType;
  readonly typeSource: 'default' | 'counterpart_match' | 'manual_confirmation';
  readonly reviewStatus: 'confirmed' | 'auto' | 'needs_review';
  /** True only via `isKnownCardPaymentReceived` — required zero manual input, same as a real match. */
  readonly viaLocalFallback: boolean;
} {
  if (row.typeOverridden) {
    const transactionType = row.suggestedType as ManualTransactionType;
    return {
      transactionType,
      typeSource: 'manual_confirmation',
      reviewStatus: reviewStatusForCorrection(categoryId, transactionType),
      viaLocalFallback: false,
    };
  }

  if (match) {
    return {
      transactionType: match.transactionType,
      typeSource: 'counterpart_match',
      reviewStatus: 'auto',
      viaLocalFallback: false,
    };
  }

  if (isKnownCardPaymentReceived(accountType, row.description!, row.amountCents!)) {
    return {
      transactionType: 'credit_card_payment',
      typeSource: 'default',
      reviewStatus: 'auto',
      viaLocalFallback: true,
    };
  }

  const transactionType = defaultTransactionType(fromDb(row.amountCents));
  return {
    transactionType,
    typeSource: 'default',
    reviewStatus: reviewStatusFor(categoryId, categorizationSource, transactionType),
    viaLocalFallback: false,
  };
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

    // Joined all the way to `financeAccounts` so `accountType` is available
    // for the counterpart-matching step below (transfer vs credit_card_payment
    // depends on whether EITHER side of a match is a credit_card account).
    // Selecting `accountId`/`accountType` from `financeAccounts` itself, past
    // an inner join, means both are structurally non-null here — no separate
    // "does this import have an account" guard needed.
    const [imp] = await tx
      .select({
        id: financeImports.id,
        status: financeImports.status,
        accountId: financeAccounts.id,
        accountType: financeAccounts.type,
      })
      .from(financeImports)
      .innerJoin(financeImportFiles, eq(financeImportFiles.importId, financeImports.id))
      .innerJoin(financeAccounts, eq(financeAccounts.id, financeImportFiles.accountId))
      .where(and(eq(financeImports.ownerId, ownerId), eq(financeImports.id, importId)))
      .limit(1);

    if (!imp) throw new NotFoundError('Import');
    if (imp.status !== 'review') throw new ImportNotReviewableError(imp.status);
    const { accountId, accountType } = imp;

    const rows = await tx
      .select()
      .from(financeImportRows)
      .where(eq(financeImportRows.importId, importId))
      .orderBy(asc(financeImportRows.rowNumber));

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

    /**
     * Counterpart matching — see classify/counterpart.ts for the full
     * reasoning. Run BEFORE insert (each candidate's own account/amount/date
     * are already known from staging), so the new row's `counterpartTransactionId`
     * can be set in its own INSERT rather than needing a follow-up UPDATE.
     * Only the OLD (already-committed) counterpart needs a follow-up UPDATE,
     * once the new row's real id exists.
     *
     * `claimedCounterpartIds` stops two different rows in this same batch from
     * both claiming the same old transaction — vanishingly unlikely (it would
     * need two genuinely different transactions sharing one confirmation
     * token), but cheap to rule out.
     */
    const claimedCounterpartIds = new Set<string>();
    const matchByRowId = new Map<
      string,
      { readonly id: string; readonly transactionType: 'transfer' | 'credit_card_payment' }
    >();

    for (const row of toInsert) {
      // An owner's own pre-commit type pick is authoritative — never a
      // candidate for auto-matching, and therefore never linked as anyone
      // else's counterpart either. Same reasoning as the `type_source =
      // 'default'` SQL filter below, one step earlier.
      if (row.typeOverridden) continue;

      const token = extractConfirmationToken(row.description!);
      if (!token) continue;

      const { start, end } = dateWindow(row.transactionDate!, COUNTERPART_WINDOW_DAYS);

      const candidates = await tx
        .select({
          id: financeTransactions.id,
          amountCents: financeTransactions.amountCents,
          description: financeTransactions.originalDescription,
          accountType: financeAccounts.type,
        })
        .from(financeTransactions)
        .innerJoin(financeAccounts, eq(financeAccounts.id, financeTransactions.accountId))
        .where(
          and(
            eq(financeTransactions.ownerId, ownerId),
            // Never touch a row a rule, a prior match, or (once M7 ships) a
            // manual confirmation already decided — see schema.ts and
            // FINANCE.md. Filtered here so an ineligible row can't even be
            // selected as a candidate, not just skipped when found.
            eq(financeTransactions.typeSource, 'default'),
            ne(financeTransactions.accountId, accountId),
            gte(financeTransactions.transactionDate, start),
            lte(financeTransactions.transactionDate, end),
            ilike(financeTransactions.originalDescription, `%${token}%`),
          ),
        );

      const eligible = candidates.filter((candidate) => !claimedCounterpartIds.has(candidate.id));
      const match = findQualifyingCounterpart(token, row.amountCents!, accountType, eligible);

      if (match) {
        matchByRowId.set(row.id, match);
        claimedCounterpartIds.add(match.id);
      }
    }

    let autoClassifiedCount = 0;
    const fallbackClassifiedIds = new Set<string>();

    if (toInsert.length > 0) {
      const inserted = await tx
        .insert(financeTransactions)
        .values(
          toInsert.map((row) => {
            const match = matchByRowId.get(row.id);
            const categoryId = row.suggestedCategoryId;
            // Narrowed by construction: `staging.ts`/`updateRowDecision` never
            // write anything else into this column.
            const categorizationSource = row.categorizationSource as 'manual' | 'merchant_memory' | null;
            const classified = classifyRow(row, accountType, match, categoryId, categorizationSource);
            if (classified.viaLocalFallback) fallbackClassifiedIds.add(row.id);

            return {
              ownerId,
              accountId,
              importId,
              transactionDate: row.transactionDate!,
              postedDate: row.postedDate,
              originalDescription: row.description!,
              normalizedMerchant: row.normalizedMerchant,
              amountCents: row.amountCents!,
              transactionType: classified.transactionType,
              categoryId,
              sourceTransactionId: row.sourceTransactionId,
              reviewStatus: classified.reviewStatus,
              categorizationSource,
              typeSource: classified.typeSource,
              counterpartTransactionId: match?.id ?? null,
              dedupeKey: row.dedupeKey!,
              dedupeKeyVersion: row.dedupeKeyVersion,
              notes: row.reviewNote,
            };
          }),
        )
        .returning({ id: financeTransactions.id });

      // A single multi-row INSERT ... RETURNING preserves VALUES order in
      // Postgres, so `inserted[index]` is `toInsert[index]`'s real row.
      for (const [index, row] of toInsert.entries()) {
        const match = matchByRowId.get(row.id);
        if (!match) continue;

        const newTransactionId = inserted[index]!.id;

        // Re-checks `type_source = 'default'` even though the SELECT above
        // already filtered on it — nothing changed it in between within this
        // transaction, but the guard costs nothing and states the invariant
        // at the point that actually matters: the write.
        //
        // `reviewStatus` only moves needs_review → auto (a CASE, not a flat
        // set): this counterpart may have committed BEFORE its match existed,
        // with no category and therefore needs_review — now correctly
        // excluded, it needs no owner attention either. But if the owner had
        // already looked at it and confirmed a category, that 'confirmed'
        // status is left exactly as it was; the type classification here must
        // never appear to touch a decision the owner already made.
        await tx
          .update(financeTransactions)
          .set({
            transactionType: match.transactionType,
            typeSource: 'counterpart_match',
            counterpartTransactionId: newTransactionId,
            reviewStatus: sql`case when ${financeTransactions.reviewStatus} = 'needs_review' then 'auto'::review_status else ${financeTransactions.reviewStatus} end`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(financeTransactions.id, match.id),
              eq(financeTransactions.ownerId, ownerId),
              eq(financeTransactions.typeSource, 'default'),
            ),
          );
      }

      // Merchant memory: remember whatever category ended up on each
      // committed row, whatever its source. The owner's current choice always
      // wins going forward, whether that choice was made just now or is a
      // suggestion they left untouched.
      for (const row of toInsert) {
        if (!row.suggestedCategoryId || !row.merchantKey) continue;

        await tx
          .insert(financeMerchantMemory)
          .values({ ownerId, merchantKey: row.merchantKey, categoryId: row.suggestedCategoryId })
          .onConflictDoUpdate({
            target: [financeMerchantMemory.ownerId, financeMerchantMemory.merchantKey],
            set: {
              categoryId: row.suggestedCategoryId,
              confirmedCount: sql`${financeMerchantMemory.confirmedCount} + 1`,
              lastConfirmedAt: new Date(),
            },
          });
      }

      autoClassifiedCount = toInsert.filter(
        (row) =>
          matchByRowId.has(row.id) ||
          fallbackClassifiedIds.has(row.id) ||
          row.categorizationSource === 'merchant_memory',
      ).length;
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
      autoClassifiedCount,
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
