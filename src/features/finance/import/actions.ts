'use server';

import { createHash } from 'node:crypto';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireOwner } from '@/server/auth/owner';
import { listAccounts } from '@/server/db/finance/accounts';
import { ImportNotReviewableError, NotFoundError } from '@/server/db/finance/errors';
import {
  type StageRowInput,
  commitImport,
  createStagedImport,
  discardImport,
  getCommittedCounts,
  updateRowDecision,
  MAX_UPLOAD_BYTES,
} from '@/server/db/finance/imports';
import { DEDUPE_KEY_VERSION, dedupeKey } from '@/server/finance/dedupe';
import {
  AccountFormatMismatchError,
  assertAccountCompatible,
} from '@/server/finance/import/compatibility';
import { parseBoaCardAddressHint, planStagedDecisions } from '@/server/finance/import/staging';
import { normalizeMerchant } from '@/server/finance/merchant';
import { ParseError, detectFormat, parseStatementTolerant } from '@/server/finance/parse';
import {
  type ActionResult,
  type CommitActionResult,
  type UploadResult,
  fail,
  ok,
} from './action-result';

/**
 * Server Actions for the import pipeline: upload, per-row decisions, commit,
 * discard. Every one begins with `await requireOwner()` — see
 * account-actions.ts for why that cannot be delegated to a layout.
 *
 * Domain work (format detection, tolerant parsing, merchant normalization, the
 * dedupe key, the staging-time reconciliation) is all pure — from
 * `src/server/finance/` — and stays that way. This file's only job is reading
 * the upload, calling those pure functions in order, and handing the result to
 * the repository layer.
 */

/** Turn one of the domain's expected failures into its message; anything else propagates. */
function describeError(error: unknown): string {
  if (error instanceof AccountFormatMismatchError) return error.message;
  if (error instanceof ParseError) return error.message;
  if (error instanceof NotFoundError) return error.message;
  if (error instanceof ImportNotReviewableError) return error.message;
  // A bug or a security refusal. Let it propagate rather than rendering it as
  // a field error.
  throw error;
}

function toResult(error: unknown): ActionResult {
  return fail(describeError(error));
}

/** `uploadStatementAction`'s own failure shape carries no `importId`. */
function failUpload(message: string): UploadResult {
  return { ok: false, error: message };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return createHash('sha256').update(bytes).digest('hex');
}

const accountIdSchema = z.string().uuid();
const importIdSchema = z.string().uuid();
const rowIdSchema = z.string().uuid();

/**
 * Upload, detect, parse, and stage — in memory, start to finish.
 *
 * `bytes` never touches the filesystem and is never written anywhere; it goes
 * out of scope when this function returns, on every path, success or failure.
 * That is the entire "guaranteed deletion" story for a 10 MB upload — there is
 * nothing to delete because nothing was ever persisted.
 */
export async function uploadStatementAction(formData: FormData): Promise<UploadResult> {
  const owner = await requireOwner();

  const accountIdRaw = formData.get('accountId');
  const file = formData.get('file');

  const accountIdResult = accountIdSchema.safeParse(accountIdRaw);
  if (!accountIdResult.success) return failUpload('Choose an account.');
  const accountId = accountIdResult.data;

  if (!(file instanceof File) || file.name === '') return failUpload('Choose a CSV file to upload.');
  if (file.size === 0) return failUpload('The selected file is empty.');
  if (file.size > MAX_UPLOAD_BYTES) return failUpload('Files over 10 MB are not accepted.');
  if (!file.name.toLowerCase().endsWith('.csv')) return failUpload('Only .csv files are accepted.');

  const accounts = await listAccounts(owner.userId);
  const account = accounts.find((candidate) => candidate.id === accountId);
  if (!account) return failUpload('Choose an account.');

  const bytes = new Uint8Array(await file.arrayBuffer());

  let format;
  try {
    format = detectFormat(bytes);
  } catch (error) {
    return failUpload(describeError(error));
  }

  if (format.adapter === 'generic') {
    return failUpload(
      "This file's format isn't recognized yet — Burmy currently supports Bank of America " +
        'checking and credit card exports.',
    );
  }

  try {
    assertAccountCompatible(format.adapter, account.type);
  } catch (error) {
    return failUpload(describeError(error));
  }

  let parsed;
  try {
    parsed = parseStatementTolerant(bytes);
  } catch (error) {
    return failUpload(describeError(error));
  }

  const fileSha256 = await sha256Hex(bytes);
  const sourceByLine = new Map(parsed.result.rows.map((row) => [row.lineNumber, row]));

  const candidateRows: StageRowInput[] = parsed.candidates.map((candidate) => {
    const source = sourceByLine.get(candidate.lineNumber);
    const hint =
      format.adapter === 'boa-card' ? parseBoaCardAddressHint(source?.fields.address) : undefined;
    const { normalizedMerchant, merchantKey } = normalizeMerchant(candidate.originalDescription, hint);

    return {
      rowNumber: candidate.lineNumber,
      transactionDate: candidate.transactionDate,
      postedDate: candidate.postedDate,
      description: candidate.originalDescription,
      amountCents: candidate.amountCents,
      detectedDirection: candidate.detectedDirection,
      sourceCategory: candidate.sourceCategory,
      sourceTransactionId: candidate.sourceTransactionId,
      normalizedMerchant,
      merchantKey,
      dedupeKey: dedupeKey({
        accountId,
        transactionDate: candidate.transactionDate,
        amountCents: candidate.amountCents,
        originalDescription: candidate.originalDescription,
      }),
      dedupeKeyVersion: DEDUPE_KEY_VERSION,
      // Placeholder — replaced below once Tier 2 reconciliation runs.
      decision: 'exclude',
      duplicateOfTransactionId: null,
      parseError: null,
    };
  });

  const failureRows: StageRowInput[] = parsed.failures.map((failure) => ({
    rowNumber: failure.lineNumber,
    transactionDate: null,
    postedDate: null,
    description: null,
    amountCents: null,
    detectedDirection: null,
    sourceCategory: null,
    sourceTransactionId: null,
    normalizedMerchant: null,
    merchantKey: null,
    dedupeKey: null,
    dedupeKeyVersion: DEDUPE_KEY_VERSION,
    decision: 'exclude',
    duplicateOfTransactionId: null,
    parseError: failure.message,
  }));

  const keys = candidateRows
    .map((row) => row.dedupeKey)
    .filter((key): key is string => key !== null);
  const committed = await getCommittedCounts(owner.userId, keys);

  const decisions = planStagedDecisions(
    candidateRows.map((row) => ({ rowNumber: row.rowNumber, dedupeKey: row.dedupeKey! })),
    committed,
  );
  const decisionByRow = new Map(decisions.map((decision) => [decision.rowNumber, decision]));

  const decidedRows: StageRowInput[] = candidateRows.map((row) => {
    const decision = decisionByRow.get(row.rowNumber);
    return {
      ...row,
      decision: decision?.decision ?? 'exclude',
      duplicateOfTransactionId: decision?.duplicateOfTransactionId ?? null,
    };
  });

  const { importId } = await createStagedImport(owner.userId, {
    accountId,
    originalFilename: file.name,
    fileSha256,
    adapter: format.adapter,
    rows: [...decidedRows, ...failureRows].sort((a, b) => a.rowNumber - b.rowNumber),
  });

  revalidatePath('/finance/import');
  return { ok: true, importId };
}

export async function updateRowDecisionAction(
  importId: string,
  rowId: string,
  decision: 'include' | 'exclude',
): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    await updateRowDecision(owner.userId, importIdSchema.parse(importId), rowIdSchema.parse(rowId), {
      decision: z.enum(['include', 'exclude']).parse(decision),
    });
  } catch (error) {
    return toResult(error);
  }

  revalidatePath(`/finance/import/${importId}`);
  return ok();
}

export async function updateRowCategoryAction(
  importId: string,
  rowId: string,
  categoryId: string | null,
): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    await updateRowDecision(owner.userId, importIdSchema.parse(importId), rowIdSchema.parse(rowId), {
      categoryId: categoryId === null ? null : z.string().uuid().parse(categoryId),
    });
  } catch (error) {
    return toResult(error);
  }

  revalidatePath(`/finance/import/${importId}`);
  return ok();
}

export async function commitImportAction(importId: string): Promise<CommitActionResult> {
  const owner = await requireOwner();

  try {
    const summary = await commitImport(owner.userId, importIdSchema.parse(importId));
    revalidatePath('/finance/import');
    revalidatePath(`/finance/import/${importId}`);
    return { ok: true, summary };
  } catch (error) {
    if (error instanceof NotFoundError) return { ok: false, error: error.message };
    if (error instanceof ImportNotReviewableError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function discardImportAction(importId: string): Promise<ActionResult> {
  const owner = await requireOwner();

  try {
    await discardImport(owner.userId, importIdSchema.parse(importId));
  } catch (error) {
    return toResult(error);
  }

  revalidatePath('/finance/import');
  return ok();
}
