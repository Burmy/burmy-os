/**
 * Burmy database schema.
 *
 * Mirrors docs/IMPLEMENTATION_PLAN.md §18. Where the two disagree, one of them
 * is a bug — fix it, do not let them drift.
 *
 * Conventions used throughout:
 *
 *   money      BIGINT of cents, SIGNED, positive = outflow. See finance/money.ts.
 *   dates      `date` columns in STRING mode ('YYYY-MM-DD'). A transaction date
 *              is a calendar fact, not an instant. Storing it as a timestamp
 *              invites timezone drift that silently moves a purchase into the
 *              wrong month — which corrupts the entire monthly grid.
 *   timestamps `timestamptz` for machine events (created_at, etc.).
 *   ownership  Every finance table carries owner_id. Enforcement lives in the
 *              data-access layer and is proven by integration tests.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

export const accountTypeEnum = pgEnum('account_type', [
  'checking',
  'savings',
  'credit_card',
  'brokerage',
  'cash',
]);

/** Drives grid sectioning and subtotals. See FINANCE.md "The monthly grid". */
export const categoryKindEnum = pgEnum('category_kind', ['spending', 'income', 'investment']);

export const importStatusEnum = pgEnum('import_status', [
  'uploaded',
  'parsing',
  'review',
  'committing',
  'committed',
  'failed',
  'discarded',
]);

/**
 * `transfer`, `credit_card_payment` and `investment` are EXCLUSIONARY — they
 * remove money from spending totals where it is invisible. They may only be
 * assigned via an explicit rule, a qualified counterpart match, or explicit
 * review confirmation. Never a graded heuristic. See FINANCE.md.
 */
export const transactionTypeEnum = pgEnum('transaction_type', [
  'expense',
  'refund',
  'fee',
  'adjustment',
  'income',
  'transfer',
  'credit_card_payment',
  'investment',
]);

export const reviewStatusEnum = pgEnum('review_status', ['auto', 'needs_review', 'confirmed']);

export const categorizationSourceEnum = pgEnum('categorization_source', [
  'rule',
  'merchant_memory',
  'history',
  'source_category',
  'heuristic',
  'ai',
  'manual',
]);

/** Which of the three permitted paths assigned an exclusionary type. */
export const typeSourceEnum = pgEnum('type_source', [
  'rule',
  'counterpart_match',
  'manual_confirmation',
  'default',
]);

export const rowDecisionEnum = pgEnum('row_decision', ['pending', 'include', 'exclude']);

export const duplicateKindEnum = pgEnum('duplicate_kind', ['exact', 'near', 'file']);

export const ruleFieldEnum = pgEnum('rule_field', [
  'description',
  'normalized_merchant',
  'amount',
  'source_category',
  'account',
]);

export const ruleOperatorEnum = pgEnum('rule_operator', [
  'contains',
  'equals',
  'starts_with',
  'ends_with',
  'regex',
  'between',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Core user table, shaped to match Better Auth's expected schema so it can be
 * adopted rather than duplicated in M2. Better Auth adds session, account,
 * verification and passkey tables alongside it.
 *
 * There is exactly one row. There is no signup route — not hidden, not
 * disabled: not registered at all.
 */
export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Finance — accounts and categories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A logical source of transactions. Burmy never connects to a bank, so this is
 * purely the owner's own labelling.
 *
 * `lastFour` is OPTIONAL and is the ONLY account-number fragment ever stored.
 * A full account number must never be written here.
 */
export const financeAccounts = pgTable(
  'finance_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    institution: text('institution'),
    type: accountTypeEnum('type').notNull(),
    lastFour: text('last_four'),
    currency: text('currency').notNull().default('USD'),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('finance_accounts_owner_idx').on(t.ownerId)],
);

/**
 * The row axis of the monthly grid. Flat in V1.
 *
 * Merchant-shaped names are legitimate: "Planet Fitness" and "Amazon" are
 * ordinary categories that happen to carry a merchant rule. The transaction's
 * `normalizedMerchant` stays a separate field and is never conflated with this.
 *
 * `parentId` ships now but the V1 UI stays flat — it exists so a future rollup
 * does not require a migration on a table full of history.
 *
 * Categories are ARCHIVED, never deleted. History must stay intact.
 */
export const financeCategories = pgTable(
  'finance_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    kind: categoryKindEnum('kind').notNull().default('spending'),
    parentId: uuid('parent_id'),
    icon: text('icon'),
    color: text('color'),
    sortOrder: integer('sort_order').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Case-insensitive uniqueness among LIVE categories only, so an archived
    // "Travel" does not block creating a new one.
    uniqueIndex('finance_categories_owner_name_live_idx')
      .on(t.ownerId, sql`lower(${t.name})`)
      .where(sql`${t.archivedAt} is null`),
    index('finance_categories_owner_idx').on(t.ownerId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Finance — imports and staging
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One import = one BATCH = one review session, spanning multiple files.
 *
 * Multi-file batches are not a convenience feature. Transfers and credit-card
 * payments have TWO legs, and matching them requires both files present at
 * once. Importing checking in January and the card in February makes the match
 * impossible.
 */
export const financeImports = pgTable(
  'finance_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    status: importStatusEnum('status').notNull().default('uploaded'),
    rowCount: integer('row_count').notNull().default(0),
    dateRangeStart: date('date_range_start', { mode: 'string' }),
    dateRangeEnd: date('date_range_end', { mode: 'string' }),
    errorMessage: text('error_message'),
    /**
     * Staged imports expire after 60 days, NOT 7. Burmy is used monthly; a
     * 7-day sweep would delete an in-progress review before the owner ever
     * returned to it. Extended on every edit.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    committedAt: timestamp('committed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('finance_imports_owner_status_idx').on(t.ownerId, t.status),
    index('finance_imports_expires_idx').on(t.expiresAt),
  ],
);

export const financeImportFiles = pgTable(
  'finance_import_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    importId: uuid('import_id')
      .notNull()
      .references(() => financeImports.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').references(() => financeAccounts.id, { onDelete: 'set null' }),
    originalFilename: text('original_filename').notNull(),
    /** Enables the "this file was already imported" warning BEFORE parsing. */
    fileSha256: text('file_sha256').notNull(),
    adapter: text('adapter').notNull(),
    rowCount: integer('row_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('finance_import_files_import_idx').on(t.importId),
    index('finance_import_files_hash_idx').on(t.fileSha256),
  ],
);

/**
 * Staging — SANITIZED, never a raw dump of the source file.
 *
 * There is deliberately no `raw` jsonb column. Persisting every parsed cell
 * would retain columns Burmy has no use for — address fragments, internal bank
 * codes, card identifiers — in a table that lives for up to 60 days. Unmapped
 * source columns are discarded at parse time and never reach the database.
 */
export const financeImportRows = pgTable(
  'finance_import_rows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    importId: uuid('import_id')
      .notNull()
      .references(() => financeImports.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => financeImportFiles.id, { onDelete: 'cascade' }),
    rowNumber: integer('row_number').notNull(),

    transactionDate: date('transaction_date', { mode: 'string' }),
    postedDate: date('posted_date', { mode: 'string' }),
    description: text('description'),
    amountCents: bigint('amount_cents', { mode: 'number' }),

    /**
     * What sign convention the adapter OBSERVED in this file. Kept on staging
     * only, so the normalizer can ASSERT the convention rather than assume it —
     * BoA uses a single signed column in some exports and separate Debit/Credit
     * columns in others, and silently inverting a month of spending is exactly
     * the failure this guards against.
     */
    detectedDirection: text('detected_direction'),
    sourceCategory: text('source_category'),
    /** Bank-supplied identifier. ADVISORY ONLY until M4 proves it. See below. */
    sourceTransactionId: text('source_transaction_id'),

    // EVOLVING — categorization and display.
    normalizedMerchant: text('normalized_merchant'),
    merchantKey: text('merchant_key'),

    // IMMUTABLE — identity. Never derived from merchantKey. See FINANCE.md.
    dedupeKey: text('dedupe_key'),
    dedupeKeyVersion: smallint('dedupe_key_version').notNull().default(1),

    suggestedCategoryId: uuid('suggested_category_id').references(() => financeCategories.id, {
      onDelete: 'set null',
    }),
    suggestedType: transactionTypeEnum('suggested_type'),
    confidence: smallint('confidence'),
    categorizationSource: categorizationSourceEnum('categorization_source'),

    duplicateOfTransactionId: uuid('duplicate_of_transaction_id'),
    duplicateKind: duplicateKindEnum('duplicate_kind'),

    decision: rowDecisionEnum('decision').notNull().default('pending'),
    reviewNote: text('review_note'),
    /** Message only. NEVER the offending row content — that would leak into logs. */
    parseError: text('parse_error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('finance_import_rows_import_idx').on(t.importId),
    index('finance_import_rows_dedupe_idx').on(t.dedupeKey),
    index('finance_import_rows_decision_idx').on(t.importId, t.decision),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Finance — transactions (THE source of truth)
// ─────────────────────────────────────────────────────────────────────────────

export const financeTransactions = pgTable(
  'finance_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => financeAccounts.id, { onDelete: 'restrict' }),
    /** Null for manually entered transactions. */
    importId: uuid('import_id').references(() => financeImports.id, { onDelete: 'set null' }),

    transactionDate: date('transaction_date', { mode: 'string' }).notNull(),
    postedDate: date('posted_date', { mode: 'string' }),

    /** Retained verbatim — it is the input to dedupeKey and must stay stable. */
    originalDescription: text('original_description').notNull(),
    normalizedMerchant: text('normalized_merchant'),

    /** SIGNED. Positive = outflow. See finance/money.ts before touching this. */
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('USD'),

    transactionType: transactionTypeEnum('transaction_type').notNull(),
    categoryId: uuid('category_id').references(() => financeCategories.id, {
      onDelete: 'set null',
    }),

    sourceTransactionId: text('source_transaction_id'),
    /** Links the two legs of a transfer or card payment when both are present. */
    counterpartTransactionId: uuid('counterpart_transaction_id'),

    reviewStatus: reviewStatusEnum('review_status').notNull().default('auto'),
    categorizationSource: categorizationSourceEnum('categorization_source'),
    categorizationConfidence: smallint('categorization_confidence'),
    /** Which permitted path assigned the type. Audit trail for exclusions. */
    typeSource: typeSourceEnum('type_source').notNull().default('default'),

    notes: text('notes'),

    dedupeKey: text('dedupe_key').notNull(),
    dedupeKeyVersion: smallint('dedupe_key_version').notNull().default(1),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('finance_transactions_owner_date_idx').on(t.ownerId, t.transactionDate),
    index('finance_transactions_owner_category_date_idx').on(
      t.ownerId,
      t.categoryId,
      t.transactionDate,
    ),
    index('finance_transactions_owner_account_date_idx').on(
      t.ownerId,
      t.accountId,
      t.transactionDate,
    ),

    // NON-UNIQUE, deliberately. Duplicate handling is count-based multiset
    // reconciliation, so several rows legitimately share a dedupe key — two
    // genuine $5 coffees on the same day are two transactions, not a conflict.
    index('finance_transactions_owner_dedupe_idx').on(t.ownerId, t.dedupeKey),

    // NON-UNIQUE until Milestone 4 proves the identifier is stable, unique and
    // well-covered against real overlapping BoA exports, PER ACCOUNT TYPE.
    // A unique constraint added on the strength of a column's NAME would either
    // reject legitimate transactions or silently merge distinct ones.
    index('finance_transactions_owner_source_id_idx').on(
      t.ownerId,
      t.accountId,
      t.sourceTransactionId,
    ),

    index('finance_transactions_needs_review_idx')
      .on(t.ownerId)
      .where(sql`${t.reviewStatus} = 'needs_review'`),
  ],
);

/** V1.1. Children must sum EXACTLY to the parent; parent amount never changes. */
export const financeTransactionSplits = pgTable(
  'finance_transaction_splits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => financeTransactions.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').references(() => financeCategories.id, {
      onDelete: 'set null',
    }),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    notes: text('notes'),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [index('finance_transaction_splits_txn_idx').on(t.transactionId)],
);

// ─────────────────────────────────────────────────────────────────────────────
// Finance — categorization knowledge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * User-authored rules. `categoryId` and `transactionType` are BOTH nullable —
 * a rule may set a category, a type, or both. Splitting them into two tables
 * would double the matching pass and force the owner to reason about two
 * ordered lists for one mental concept ("when I see SHELL, it's Gas").
 */
export const financeRules = pgTable(
  'finance_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name'),
    field: ruleFieldEnum('field').notNull(),
    operator: ruleOperatorEnum('operator').notNull(),
    value: text('value').notNull(),
    value2: text('value2'),
    categoryId: uuid('category_id').references(() => financeCategories.id, {
      onDelete: 'cascade',
    }),
    transactionType: transactionTypeEnum('transaction_type'),
    accountId: uuid('account_id').references(() => financeAccounts.id, { onDelete: 'cascade' }),
    priority: integer('priority').notNull().default(100),
    enabled: boolean('enabled').notNull().default(true),
    matchCount: integer('match_count').notNull().default(0),
    lastMatchedAt: timestamp('last_matched_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('finance_rules_owner_priority_idx').on(t.ownerId, t.priority)],
);

/**
 * Learned from corrections — distinct from rules, which are explicit and
 * user-authored. This is what makes month 6 nearly zero-review, and that
 * convergence is measured, not assumed: a merchant confirmed in month 1 must
 * require zero review in month 2.
 */
export const financeMerchantMemory = pgTable(
  'finance_merchant_memory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    merchantKey: text('merchant_key').notNull(),
    categoryId: uuid('category_id').references(() => financeCategories.id, {
      onDelete: 'cascade',
    }),
    transactionType: transactionTypeEnum('transaction_type'),
    confirmedCount: integer('confirmed_count').notNull().default(1),
    lastConfirmedAt: timestamp('last_confirmed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('finance_merchant_memory_owner_key_idx').on(t.ownerId, t.merchantKey)],
);

/** Remembered CSV layouts, so an unknown format needs mapping exactly once. */
export const financeFormatSignatures = pgTable(
  'finance_format_signatures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    /** Hash of the normalized header-name set. Filenames are never used. */
    signature: text('signature').notNull(),
    mapping: jsonb('mapping').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('finance_format_signatures_owner_sig_idx').on(t.ownerId, t.signature)],
);

// ─────────────────────────────────────────────────────────────────────────────
// Finance — balances and reconciliation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Point-in-time state, unlike everything else in the model, which is flow.
 *
 * NEVER derived from transfer flows. Once interest or market movement is
 * involved, a derived balance drifts from reality permanently and silently.
 */
export const financeBalanceSnapshots = pgTable(
  'finance_balance_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => financeAccounts.id, { onDelete: 'cascade' }),
    asOfDate: date('as_of_date', { mode: 'string' }).notNull(),
    balanceCents: bigint('balance_cents', { mode: 'number' }).notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('finance_balance_snapshots_account_date_idx').on(t.accountId, t.asOfDate)],
);

/**
 * The owner's Excel totals — hand-verified ground truth for what each
 * category x month SHOULD be. Compared against computed totals to validate the
 * importer, deduplication, categorization and money arithmetic against years of
 * real data. An unexplained non-zero delta is a bug, not rounding.
 *
 * `categoryLabel` keeps the raw Excel text so an unmapped label is never lost.
 */
export const financeExpectedTotals = pgTable(
  'finance_expected_totals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    periodMonth: date('period_month', { mode: 'string' }).notNull(),
    categoryLabel: text('category_label').notNull(),
    categoryId: uuid('category_id').references(() => financeCategories.id, {
      onDelete: 'set null',
    }),
    expectedCents: bigint('expected_cents', { mode: 'number' }).notNull(),
    sourceFilename: text('source_filename'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('finance_expected_totals_owner_period_label_idx').on(
      t.ownerId,
      t.periodMonth,
      t.categoryLabel,
    ),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Audit
// ─────────────────────────────────────────────────────────────────────────────

/** Metadata is REDACTED — never raw descriptions, never amounts. */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').references(() => user.id, { onDelete: 'set null' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    eventType: text('event_type').notNull(),
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
    metadata: jsonb('metadata'),
  },
  (t) => [index('audit_events_owner_at_idx').on(t.ownerId, t.at)],
);
