/**
 * Burmy database schema.
 *
 * Mirrors docs/FINANCE.md's data model. Where the two disagree, one of them
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
  type AnyPgColumn,
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

// ── Games ───────────────────────────────────────────────────────────────────

/** Where a game was played. `other` covers retro/emulated/misc without inventing a taxonomy. */
export const gamePlatformEnum = pgEnum('game_platform', ['ps5', 'ps4', 'psp', 'steam', 'pc', 'other']);

export const gameOwnershipEnum = pgEnum('game_ownership', ['physical', 'digital']);

/**
 * Lifecycle. `paused_dropped` is deliberately ONE state, not two: the
 * difference between "I'll come back" and "I won't" is a sentence in `notes`,
 * not a schema decision, and splitting it would put two nearly-identical
 * buckets in every filter.
 *
 * `completed` was renamed to `played` in migration 0013 (`ALTER TYPE …
 * RENAME VALUE`) once real usage showed 171 of 180 games sat in that one
 * bucket — a status describing 95% of the library carries no information.
 * `played` is the app's invisible default for "this game has simply been
 * played" (see `StatusBadge`, which renders nothing for it) and a non-null
 * sentinel rather than a nullable column, so every count/filter and the
 * `wanted` exclusion stay plain non-null SQL. `paused_dropped` had ZERO rows
 * at the same audit and is no longer reachable from the app (removed from
 * `GAME_STATUSES` in `src/server/games/taxonomy.ts`) — it stays in this
 * Postgres enum only because Postgres has no `DROP VALUE`; removing it here
 * would mean creating a new type, swapping the column, and re-pointing the
 * default and its indexes for a value nothing ever writes.
 */
export const gameStatusEnum = pgEnum('game_status', [
  'backlog',
  'playing',
  'played',
  'paused_dropped',
  // Added in migration 0011 — a wishlist entry sourced from IGDB's upcoming
  // query, not yet owned. See "Upcoming games" in docs/GAMES.md.
  'wanted',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The single owner row. Provisioned once, out of band, by
 * `scripts/provision-owner.mjs` — `requireOwner()`
 * (`src/server/auth/owner.ts`) only ever RESOLVES it by the email Cloudflare
 * Access verifies, never creates one.
 *
 * There is exactly one row. There is no signup route — not hidden, not
 * disabled: not registered at all.
 *
 * Shaped the way it is (rather than a narrower, Burmy-specific shape) because
 * this table was originally adopted from Better Auth's schema in M2. Better
 * Auth and its passkey plugin have since been removed entirely — Cloudflare
 * Access with Google is now the sole authentication mechanism — but `id` /
 * `name` / `email` / `emailVerified` remain exactly as they were, since every
 * finance table's `owner_id` foreign key points at `user.id` and there is no
 * reason to touch a working, referenced column shape.
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

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * FORMER BETTER AUTH TABLES — RETAINED, UNUSED, NOT DEAD DATA
 *
 * Better Auth and its passkey plugin were removed as part of the switch to
 * Cloudflare Access + Google as the sole authentication mechanism (see
 * docs/SECURITY.md, "Authentication"). Nothing in the application writes to
 * `session`, `account`, `verification`, `passkey` or `rateLimit` anymore.
 *
 * They are kept rather than dropped because removing them would require a
 * destructive migration for no concrete benefit — CLAUDE.md's standing rule is
 * that unused tables stay unless there is a real reason to drop them. If a
 * later milestone genuinely needs the space or the names, drop them then, in
 * their own reviewed migration.
 *
 * The field list below is transcribed from Better Auth 1.6.29's own
 * `getAuthTables()` (`@better-auth/core/dist/db/get-tables.mjs`) and the
 * passkey plugin's `src/schema.ts`, from when they were still in use. It is
 * historical record now, not a contract with a live adapter.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Server-side session store. This is what makes revocation INSTANT — deleting
 * the row ends the session on the next request, with no window in which a
 * signed stateless token remains valid.
 */
export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [index('session_user_idx').on(t.userId)],
);

/**
 * Better Auth's core schema includes this table unconditionally, so it exists.
 *
 * Burmy writes NOTHING to it: there is no password authentication and no OAuth
 * provider configured in Better Auth — Google is configured exactly once, in
 * Cloudflare Access. An `account` row appearing here in production means
 * someone added a credential provider, which is a review finding, not a
 * feature. The `password` column must stay permanently null.
 */
export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('account_user_idx').on(t.userId)],
);

/**
 * Formerly held short-lived single-use values: Better Auth's own WebAuthn
 * challenges, plus Burmy's bootstrap-enrollment and break-glass recovery
 * tokens (`identifier` the token, `value` the JSON payload). See the group
 * comment above — unused now that Cloudflare Access is the sole mechanism.
 */
export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

/**
 * Registered WebAuthn credentials — FACTOR 2.
 *
 * `publicKey` is a public key: it authenticates, it does not decrypt, and it is
 * not a secret. The private key never leaves the authenticator, which is the
 * entire reason a passkey is a different factor from a Google password.
 *
 * At least TWO rows must exist before onboarding completes. One passkey is a
 * single point of failure, and the recovery path is deliberately awkward.
 */
export const passkey = pgTable(
  'passkey',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    publicKey: text('public_key').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    credentialID: text('credential_id').notNull(),
    counter: integer('counter').notNull(),
    deviceType: text('device_type').notNull(),
    backedUp: boolean('backed_up').notNull(),
    transports: text('transports'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    aaguid: text('aaguid'),
  },
  (t) => [
    index('passkey_user_idx').on(t.userId),
    // Better Auth declares this `index: true`, not unique. It is made UNIQUE
    // here on purpose: `verifyPasskeyAuthentication` looks a credential up by
    // `credentialID` with `findOne`, so two rows sharing one credential id
    // would make which passkey authenticates depend on row order. A WebAuthn
    // credential id is globally unique by construction; enforcing that is free.
    uniqueIndex('passkey_credential_id_idx').on(t.credentialID),
  ],
);

/**
 * Rate-limit counters, in the DATABASE rather than in memory.
 *
 * Better Auth's default limiter is per-process memory, which resets on every
 * deploy and every container restart. The endpoint that most needs a limiter is
 * break-glass recovery, and "redeploy to clear the lockout" is not a property a
 * break-glass path should have. One small table buys a limiter that survives
 * restarts. Cloudflare still rate-limits at the edge; this is the origin-side
 * layer that works even if the origin is reached another way.
 */
export const rateLimit = pgTable('rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
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
    /**
     * Did the OWNER explicitly set `decision` (or did it come from staging-time
     * Tier 2 reconciliation and nothing has touched it since)?
     *
     * This is what lets `commitImport()` re-run reconciliation against the
     * CURRENT committed count immediately before inserting — closing the race
     * where two concurrently staged imports both see the same key as unclaimed
     * surplus — without discarding a deliberate owner override. A row the owner
     * flipped back to Include after reviewing it (a genuine same-day repeat the
     * heuristic mis-flagged) is honoured as-is; a row still following the default
     * is re-checked against the fresh count and demoted if a concurrent commit
     * already claimed the surplus. See docs/FINANCE.md.
     */
    decisionOverridden: boolean('decision_overridden').notNull().default(false),
    /**
     * Did the OWNER explicitly pick `suggestedType` (vs. it being M6-era
     * staging preview — see `previewCounterpartType` in `db/finance/imports.ts`)?
     * Mirrors `decisionOverridden` exactly. `commitImport()` skips an
     * overridden row entirely when searching for a counterpart match — an
     * explicit owner pick is authoritative and must never be silently
     * replaced by automation running in the same commit.
     */
    typeOverridden: boolean('type_overridden').notNull().default(false),
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

// ─────────────────────────────────────────────────────────────────────────────
// Games
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One row per game owned, wanted, or played. Replaces a hand-maintained
 * spreadsheet.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOURS ARE ONE NUMBER, NOT A SESSION LOG.
 *
 * The source spreadsheet wrote "53 + 6" in an hours cell — which looks like
 * session tracking but is not. It meant "53 hours on the base game in 2025, 6
 * on the DLC in 2026", kept visually separate only so a manual yearly rollup
 * stayed readable. A `play_sessions` table was considered and REJECTED: the
 * owner logs a total, once, by hand. `notes` carries the DLC nuance in plain
 * language.
 *
 * `firstPlayedYear` is nullable and genuinely sparse — pre-2015 PSP/PS2 entries
 * carry a rating and nothing else. That is data, not an omission to backfill.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const games = pgTable(
  'games',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    platform: gamePlatformEnum('platform').notNull().default('other'),
    developer: text('developer'),
    publisher: text('publisher'),
    ownership: gameOwnershipEnum('ownership'),
    /** Signed cents, same convention as finance. Independent of finance_transactions by design. */
    priceCents: bigint('price_cents', { mode: 'number' }),
    status: gameStatusEnum('status').notNull().default('backlog'),
    /** 1-5. Nullable: an unplayed backlog entry has no opinion yet. */
    rating: smallint('rating'),
    /** Tenths of an hour, stored as an integer so no float ever touches a total. 235 = 23.5h. */
    hoursTenths: integer('hours_tenths'),
    firstPlayedYear: smallint('first_played_year'),
    achievementsUnlocked: smallint('achievements_unlocked'),
    achievementsTotal: smallint('achievements_total'),
    coverUrl: text('cover_url'),
    genre: text('genre'),
    notes: text('notes'),
    /**
     * Whether the owner earned the platinum trophy. Stored as a flag, NOT
     * derived from `achievementsUnlocked === achievementsTotal`, for two
     * reasons: the source spreadsheet only ever recorded trophies EARNED,
     * never the total, so it cannot be derived for any of the 160 imported
     * games; and on Steam, 100% achievements is not a platinum at all — the
     * concept is PlayStation-specific and has no Steam equivalent to derive.
     */
    platinum: boolean('platinum').notNull().default(false),
    /** Metacritic-style critic score 0-100, from IGDB's `aggregated_rating`. Nullable — not every game has one. */
    metacritic: smallint('metacritic'),
    /**
     * IGDB's `game_time_to_beats.normally`, converted from seconds to whole
     * hours. Deliberately NOT stored in tenths unlike `hoursTenths`: this is
     * a coarse third-party estimate, not the owner's own measured time, so
     * it doesn't carry the same precision contract — don't "fix" this
     * inconsistency by converting it to tenths.
     */
    averagePlaytimeHours: smallint('average_playtime_hours'),
    esrbRating: text('esrb_rating'),
    /**
     * Steam's stable numeric app id (e.g. 1091500 for Cyberpunk 2077).
     * Nullable — most rows predate the Steam sync and PS/PSP rows never get
     * one at all.
     *
     * Once a library row is matched to a Steam app, THIS is what the sync
     * script (`scripts/sync-steam-library.mjs`) looks up on every later run,
     * never the title again. Title matching is the risky part of the whole
     * feature — the owner's titles carry edition/store noise ("[Launch
     * Edition]", "(itch)") that already defeated IGDB's matcher (see
     * docs/GAMES.md) — so it happens at most once per game, with the result
     * persisted here, exactly like the "resolve the match once, persist the
     * external id" approach `psn-integration-research.md` recommends for any
     * third-party library sync.
     */
    steamAppid: integer('steam_appid'),
    /**
     * PSN's stable per-title id (e.g. `CUSA12345_00`), TEXT not numeric —
     * unlike Steam's `steamAppid`. Played-game data (hours, first played,
     * platform) is keyed by this id.
     *
     * `psnTitleId` and `psnNpCommunicationId` below are TWO SEPARATE
     * identifier spaces with no join key between them except the game's
     * name: trophy data (counts, platinum) is keyed by
     * `npCommunicationId`, not `titleId`. Both are stored because the sync
     * engine resolves each independently against the owner's library, the
     * same "resolve the match once, persist the external id" precedent
     * `steamAppid` already set.
     */
    psnTitleId: text('psn_title_id'),
    /** See `psnTitleId` above — a separate id space, used only for trophy data. */
    psnNpCommunicationId: text('psn_np_communication_id'),
    /** Most recent play activity PSN reported for this title, if any. */
    lastPlayedAt: timestamp('last_played_at', { withTimezone: true }),
    /**
     * A calendar fact, not an instant — same `date`-string convention as
     * finance transaction dates (see this file's header comment). Populated
     * for a `wanted` row from IGDB's upcoming query, and read by the
     * auto-flip (`wanted` -> `backlog` once this date has passed).
     */
    releaseDate: date('release_date', { mode: 'string' }),
    /**
     * Whether `release_date` names a REAL DAY or only a month.
     *
     * IGDB tags every release date with a `date_format`: `0` means it knows
     * the exact day, `1` means it genuinely only knows the month (GTA VI is
     * "November 2026", full stop). A month-precision row is stored as
     * `YYYY-MM-01`, so the day component is a placeholder — and without this
     * column there is no way to tell that `2026-11-01` from a game that
     * really does launch on 1 November.
     *
     * Deliberately NOT inferred from `day === 1`: roughly one real release
     * date in thirty lands on the 1st, and those would silently render as
     * "November 2026" instead of counting down. Nullable because most rows
     * have no release date at all to be precise about.
     */
    releasePrecision: text('release_precision', { enum: ['day', 'month'] }),
    /**
     * IGDB's numeric game id, stamped only on rows created from the
     * "Upcoming games" wishlist flow. Exact-dedup key: is this IGDB game
     * already wishlisted? Nullable — every pre-existing row and every
     * manually-added game has no IGDB id at all.
     */
    igdbId: integer('igdb_id'),
    /**
     * The COLLECTION this game belongs to — a self-reference to another
     * `games` row. `null` for a standalone game and for a collection row
     * itself; only the individual titles INSIDE a collection carry it.
     *
     * ─────────────────────────────────────────────────────────────────────
     * WHY THIS EXISTS: THE SOURCE DATA ALWAYS HAD IT, AND THE IMPORT DROPPED IT.
     *
     * A physical collection — "Uncharted: The Nathan Drake Collection" (3
     * games), "Legacy of Thieves Collection" (2) — is ONE purchase with ONE
     * price, ONE play time and ONE trophy list, but several distinct games
     * the owner counts separately. The source spreadsheet modelled exactly
     * that: a parent row carrying the money/hours/trophies, with the
     * individual titles as INDENTED sub-rows beneath it carrying only a name
     * and a year.
     *
     * `scripts/import-game-log.mjs` saw those rows — its own comment calls
     * them "sparse collection-stub rows" — and imported each as a full,
     * INDEPENDENT `games` row, discarding the indentation that made them
     * children. That is the whole bug: the titles are not wrong, they are
     * ORPHANED. Disconnected from their collection they render as unplayed
     * `backlog` entries with no hours, no art and no rating, inflate the
     * backlog count, and drag down every per-game average.
     *
     * This column is NOT a speculative abstraction (CLAUDE.md forbids those):
     * the relationship is observed in real production data, the source system
     * already modelled it, and it recurs across multiple collections.
     *
     * ONE LEVEL ONLY. A child may never itself be a collection — its target
     * must be a row whose own `collection_id` is null. Enforced in the data-
     * access layer plus an integration test rather than a CHECK constraint
     * (which would need a subquery), the same call M6 made for
     * `counterpart_transaction_id`.
     *
     * `ON DELETE SET NULL`, deliberately NOT `CASCADE`: removing a collection
     * must never destroy the games inside it. They become standalone entries,
     * which is the same non-destructive default categories (archive) and
     * accounts (deactivate) already follow. A cascade would turn one "Remove"
     * click into three silent deletions of real history.
     * ─────────────────────────────────────────────────────────────────────
     */
    collectionId: uuid('collection_id').references((): AnyPgColumn => games.id, {
      onDelete: 'set null',
    }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Case-insensitive uniqueness per platform: the same title legitimately
    // exists twice when replayed on a different platform (PS4 then PS5), but
    // twice on ONE platform is always a duplicate entry.
    uniqueIndex('games_owner_title_platform_idx').on(t.ownerId, sql`lower(${t.title})`, t.platform),
    index('games_owner_idx').on(t.ownerId),
    index('games_owner_status_idx').on(t.ownerId, t.status),
    index('games_owner_year_idx').on(t.ownerId, t.firstPlayedYear),
    // Partial: only rows that have actually been matched to a Steam app
    // carry a value here, and one Steam app maps to at most one library row
    // per owner. Mirrors `finance_categories_owner_name_live_idx`'s partial-
    // uniqueness shape (there: live categories only; here: matched rows only).
    uniqueIndex('games_owner_steam_appid_idx')
      .on(t.ownerId, t.steamAppid)
      .where(sql`${t.steamAppid} is not null`),
    // Same partial-uniqueness shape as the Steam index above, for the same
    // reason: only rows matched to a PSN title carry a value here, and one
    // PSN title maps to at most one library row per owner. `psnNpCommunicationId`
    // deliberately gets NO uniqueness constraint — see the field comment.
    uniqueIndex('games_owner_psn_title_id_idx')
      .on(t.ownerId, t.psnTitleId)
      .where(sql`${t.psnTitleId} is not null`),
    // Same partial-uniqueness shape as the Steam/PSN indexes above: only
    // rows created from the upcoming-games wishlist flow carry a value
    // here, and one IGDB game maps to at most one library row per owner.
    // Makes a double-add a clean isUniqueViolation(), not a duplicate row.
    uniqueIndex('games_owner_igdb_id_idx')
      .on(t.ownerId, t.igdbId)
      .where(sql`${t.igdbId} is not null`),
    // Partial, same shape as the three above: only the titles inside a
    // collection carry a value here, and every read of it ("this
    // collection's games", "is this row a child") is owner-scoped. A full
    // index would be mostly nulls — the standalone games and the collection
    // rows themselves.
    index('games_owner_collection_idx')
      .on(t.ownerId, t.collectionId)
      .where(sql`${t.collectionId} is not null`),
  ],
);

/**
 * Optional per-year attribution of a game's play time.
 *
 * A game with NO rows here attributes all of `games.hours_tenths` to
 * `games.first_played_year` — the behaviour every game had before this table
 * existed, which is why ~157 of 160 rows needed no backfill.
 *
 * `games.hours_tenths` stays the authoritative total; these rows only say
 * WHICH YEARS it happened in. See src/server/games/play-years.ts.
 */
export const gamePlayYears = pgTable(
  'game_play_years',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    year: smallint('year').notNull(),
    hoursTenths: integer('hours_tenths').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One row per game per year — two rows for the same year would be an
    // ambiguous split, not extra detail.
    uniqueIndex('game_play_years_game_year_idx').on(t.gameId, t.year),
    index('game_play_years_owner_idx').on(t.ownerId),
  ],
);

/**
 * Every individual trophy/achievement defined for a game the owner owns, both
 * PlayStation and Steam, earned or not.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS TABLE EXISTS AT ALL.
 *
 * Trophies used to be fetched from PSN live on every game-page visit and thrown
 * away — measured at ~1.0s on first view and ~1.5s on reload, every time, with
 * no caching. Worse than the wait: nothing about trophies was queryable across
 * games, so "what am I close to platinuming", "what did I earn this month" and
 * "what is the rarest thing I own" were all unanswerable, in an app whose owner
 * uses it primarily to track trophies. PSN was already returning the earned
 * timestamp and the rarity percentage; both were parsed and then discarded.
 *
 * ONE TABLE FOR BOTH SOURCES. Steam has no notion of a tier or a trophy group,
 * so `tier` and `group_id` are nullable and PSN-only — the alternative, two
 * near-identical tables, would fork every query that wants a combined answer
 * ("earned recently" across everything the owner plays) for the sake of two
 * columns.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const gameTrophySourceEnum = pgEnum('game_trophy_source', ['psn', 'steam']);
export const gameTrophyTierEnum = pgEnum('game_trophy_tier', ['bronze', 'silver', 'gold', 'platinum']);

export const gameTrophies = pgTable(
  'game_trophies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    source: gameTrophySourceEnum('source').notNull(),
    /** PSN `trophyId` (unique within a title only) or Steam `apiname`. Never globally unique — see the index below. */
    externalId: text('external_id').notNull(),
    name: text('name'),
    description: text('description'),
    iconUrl: text('icon_url'),
    /** PSN only. Steam has no tiers, and inventing one would misrepresent its data. */
    tier: gameTrophyTierEnum('tier'),
    /** PSN `trophyGroupId` — `default` for the base game, `001`/`002`… for DLC. PSN only. */
    groupId: text('group_id'),
    hidden: boolean('hidden').notNull().default(false),
    earned: boolean('earned').notNull().default(false),
    /** Null whenever `earned` is false. PSN reports this directly; Steam's `unlocktime` is converted. */
    earnedAt: timestamp('earned_at', { withTimezone: true }),
    /**
     * Percentage of players who earned this, in TENTHS of a percent — `225`
     * means 22.5%.
     *
     * An integer, deliberately, not `NUMERIC`. Both APIs report exactly one
     * decimal place (PSN `trophyEarnedRate: "22.5"`, Steam `percent: "76.8"`),
     * and CLAUDE.md forbids `NUMERIC` outright because the `pg` driver hands it
     * back as a STRING — the resulting `parseFloat` is the precise bug this
     * project is built to avoid. Games already stores `hours_tenths` this way;
     * rarity follows the same rule, with conversion contained in
     * `src/server/games/trophies.ts` and nowhere else.
     *
     * Null when the API did not report a rate, which is a real state — never
     * coerced to 0, which would claim "nobody has this."
     */
    rarityTenths: integer('rarity_tenths'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // What makes a re-sync an UPSERT rather than a duplicate. `external_id` is
    // only unique within a title (PSN restarts `trophyId` at 0 for every game),
    // so the game and the source both have to be part of the key.
    uniqueIndex('game_trophies_owner_game_source_external_idx').on(t.ownerId, t.gameId, t.source, t.externalId),
    index('game_trophies_owner_game_idx').on(t.ownerId, t.gameId),
    // Partial, because both ordered views only ever look at earned rows — an
    // index covering the ~40% that are unearned would be that much dead weight
    // in a scan that can never return them.
    index('game_trophies_owner_earned_at_idx')
      .on(t.ownerId, t.earnedAt.desc())
      .where(sql`${t.earned}`),
    index('game_trophies_owner_rarity_idx')
      .on(t.ownerId, t.rarityTenths)
      .where(sql`${t.earned}`),
  ],
);

export const gameSyncSourceEnum = pgEnum('game_sync_source', ['steam', 'psn']);
export const gameSyncRunStatusEnum = pgEnum('game_sync_run_status', [
  'running',
  'ready',
  'committed',
  'failed',
  'cancelled',
]);

/**
 * One Steam (later: PSN) sync run.
 *
 * Processed in small client-driven chunks rather than one long request, so no
 * single call approaches a serverless timeout and progress is real rather than
 * a spinner. `cursor` is how many library games have been processed; `total` is
 * how many there are. A run persists, so closing the tab mid-sync leaves a
 * resumable run rather than a lost one.
 */
export const gameSyncRuns = pgTable(
  'game_sync_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    source: gameSyncSourceEnum('source').notNull(),
    status: gameSyncRunStatusEnum('status').notNull().default('running'),
    /**
     * `cursor`/`total` are for PROGRESS DISPLAY only ("7 of 47") — `total` is
     * a snapshot of the owner's Steam-platform game count taken when the run
     * was created, and a game deleted or inserted mid-run can make it an
     * estimate the cursor never exactly reaches. `lastGameId` below, not
     * this pair, is what the engine uses to decide what to process next and
     * when the run is actually done.
     */
    cursor: integer('cursor').notNull().default(0),
    total: integer('total').notNull().default(0),
    /**
     * Keyset pagination bookmark: the `id` of the last Steam-platform game
     * this run has processed, in `id` order. `null` means no chunk has run
     * yet. The next chunk queries `id > lastGameId ORDER BY id LIMIT
     * CHUNK_SIZE`, and the run is done once that query returns nothing —
     * not once `cursor` reaches `total`. That is what makes a game deleted
     * mid-run harmless (the cursor simply never has to "arrive" anywhere)
     * instead of stranding the run in `running` forever.
     *
     * Deliberately NOT a foreign key. An `ON DELETE SET NULL` would silently
     * rewind an in-progress run to the very beginning the moment its
     * last-processed game was deleted, restaging every change before it —
     * worse than the bug this column exists to fix. This is a pagination
     * bookmark, not a reference, so a deleted game's id can safely keep
     * living here as an opaque marker forever.
     */
    lastGameId: uuid('last_game_id'),
    /**
     * The owner's Steam library as fetched ONCE at the start of the run —
     * appid, name and playtime only. Held here so each chunk does not re-fetch
     * the whole list, and so a resumed run matches against exactly the same
     * snapshot it started with rather than a library that moved underneath it.
     * Transient run state, discarded with the run.
     */
    steamLibrary: jsonb('steam_library'),
    errorMessage: text('error_message'),
    /**
     * A SHA-256 fingerprint of the `PSN_NPSSO` value that made THIS run
     * possible — hex, truncated to 16 chars, computed by
     * `currentPsnTokenFingerprint()` in `src/server/db/games/psn-client.ts`.
     * One-way: this is a hash, not the token, so it never lets anyone
     * recover the secret from the database, and it never leaves the
     * database — no Server Action returns it to the client. It exists
     * purely so the app can tell "the owner is still using the same PSN
     * token" apart from "a new one was just pasted," without storing the
     * token itself or a raw "issued at" date: pasting a new token changes
     * its fingerprint, which is what lets "in use since" naturally restart
     * from the token that is actually active now. Set only on a
     * SUCCESSFULLY created `source: 'psn'` run — never for Steam, and never
     * merely because `PSN_NPSSO` was configured. `null` for every run that
     * predates this column, and for every Steam run.
     */
    psnTokenFingerprint: text('psn_token_fingerprint'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('game_sync_runs_owner_status_idx').on(t.ownerId, t.status)],
);

/**
 * One proposed change staged by a run. Nothing here has been written to
 * `games` — that happens only when the owner approves the run.
 *
 * `payload` carries both the proposed value and the value it would replace, so
 * the review screen shows a real before/after rather than just a target.
 */
export const gameSyncChanges = pgTable(
  'game_sync_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => gameSyncRuns.id, { onDelete: 'cascade' }),
    /** Null for `new_game` — that change has no library row yet, by definition. */
    gameId: uuid('game_id').references(() => games.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    selected: boolean('selected').notNull().default(true),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('game_sync_changes_run_idx').on(t.runId)],
);

// ─────────────────────────────────────────────────────────────────────────────
// Anime
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lifecycle, four states — deliberately fewer than AniList's six.
 *
 * AniList records CURRENT, PLANNING, COMPLETED, DROPPED, PAUSED and REPEATING.
 * `PAUSED` folds into `watching` and `REPEATING` into `completed` at import,
 * for the reason Games' own chip list shrank to one after real use: a status
 * that describes a state you never filter by is a filter chip nobody presses.
 * `repeat_count` still carries the rewatch signal, so folding REPEATING loses
 * nothing that mattered.
 */
export const animeStatusEnum = pgEnum('anime_status', ['watching', 'completed', 'dropped', 'planning']);

/** AniList's own `MediaFormat`, narrowed to the values an anime list actually contains. */
export const animeFormatEnum = pgEnum('anime_format', ['tv', 'tv_short', 'movie', 'ova', 'ona', 'special', 'music']);

export const animeSeasonEnum = pgEnum('anime_season', ['winter', 'spring', 'summer', 'fall']);

/** What the show was adapted from — AniList's `MediaSource`, narrowed. `original` means nothing was adapted. */
export const animeSourceEnum = pgEnum('anime_source', [
  'original',
  'manga',
  'light_novel',
  'visual_novel',
  'video_game',
  'novel',
  'doujinshi',
  'anime',
  'other',
]);

export const animeSyncRunStatusEnum = pgEnum('anime_sync_run_status', [
  'running',
  'ready',
  'committed',
  'failed',
  // Never written today. Present because Postgres has no `DROP VALUE` but
  // adding one is trivial — and a run the owner abandons is a real state the
  // Games engine already models. Free now, a migration later.
  'cancelled',
]);

/**
 * A franchise wrapping several seasons — "Attack on Titan" holding Season 1,
 * Season 2 and The Final Season.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ITS OWN TABLE AND NOT A SELF-FK LIKE `games.collection_id`.
 *
 * Games models a boxed set as a `games` row that other rows point at, and that
 * is right there: a boxed set is a real thing you bought, with one price and
 * one play time. A SERIES is not. Nobody watched "Attack on Titan" — they
 * watched its seasons. A series has no episode count, no progress, no status
 * and no watch date, so a self-FK would mean every series row carrying half a
 * dozen columns that mean nothing, plus a rule in every aggregate to exclude
 * them.
 *
 * A separate table makes that impossible by construction: a series can never
 * be counted as a show, because it is not in the `anime` table at all. That is
 * the whole reason it was chosen over the shape Games uses.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const animeSeries = pgTable(
  'anime_series',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /**
     * An OVERRIDE, never a synced or derived copy. Left null, the UI shows the
     * cover of the earliest season — deriving it rather than storing it, so the
     * two can never drift. It exists only for the case where a franchise has key
     * art that belongs to no single season.
     */
    coverUrl: text('cover_url'),
    /** The AniList media id this series was derived from, when the relations graph proposed it. */
    anilistParentId: integer('anilist_parent_id'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('anime_series_owner_title_idx').on(t.ownerId, sql`lower(${t.title})`),
    // What makes a re-sync resolve the SAME series rather than creating a
    // second one. The title alone cannot: it is produced by a heuristic that
    // strips "Season 2" and friends, the owner can rename it, and either would
    // let the next run miss the match and insert a duplicate franchise.
    uniqueIndex('anime_series_owner_anilist_parent_idx')
      .on(t.ownerId, t.anilistParentId)
      .where(sql`${t.anilistParentId} is not null`),
    index('anime_series_owner_idx').on(t.ownerId),
  ],
);

/**
 * One watchable entry — a season, a movie, an OVA. The unit AniList tracks and
 * the unit the owner counts.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NEITHER TOTAL EPISODES NOR TOTAL TIME IS STORED.
 *
 * `progress` (episodes into the current watch) and `repeat_count` are the
 * stored facts. Everything else is arithmetic:
 *
 *   episodes watched = progress + repeat_count x episodes
 *   minutes watched  = episodes watched x duration_minutes
 *
 * Both live in `src/server/anime/runtime.ts` and nowhere else — the same
 * containment rule `money.ts` and `hours.ts` already hold. `duration_minutes`
 * is AniList's per-episode AVERAGE, not a measurement, which is why time
 * watched is presented as an estimate and never as a figure to reconcile
 * against.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const anime = pgTable(
  'anime',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /**
     * SET NULL, never cascade: deleting a series must leave its seasons in the
     * library as standalone entries. Same decision, same reasoning, as
     * `games.collection_id`.
     */
    seriesId: uuid('series_id').references(() => animeSeries.id, { onDelete: 'set null' }),
    /** AniList's `Media.id`. Resolve the match once, persist the external id — the rule `steam_appid` follows. */
    anilistMediaId: integer('anilist_media_id'),
    titleRomaji: text('title_romaji').notNull(),
    titleEnglish: text('title_english'),
    format: animeFormatEnum('format'),
    status: animeStatusEnum('status').notNull().default('planning'),
    /** How many episodes the show HAS. Null for an airing show AniList has no final count for. */
    episodes: smallint('episodes'),
    /** How many episodes into the CURRENT watch. Stored truth; never a total. */
    progress: smallint('progress').notNull().default(0),
    /** Completed rewatches. AniList's `repeat`. */
    repeatCount: smallint('repeat_count').notNull().default(0),
    /** AniList's per-episode average, in minutes. */
    durationMinutes: smallint('duration_minutes'),
    season: animeSeasonEnum('season'),
    seasonYear: smallint('season_year'),
    studio: text('studio'),
    /** Comma-joined, split at read time — exactly how `games.genre` is stored. */
    genre: text('genre'),
    source: animeSourceEnum('source'),
    synopsis: text('synopsis'),
    coverUrl: text('cover_url'),
    notes: text('notes'),
    /** Calendar facts, not instants — the same `mode: 'string'` reasoning as `games.release_date`. */
    startedAt: date('started_at', { mode: 'string' }),
    completedAt: date('completed_at', { mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // NO UNIQUE INDEX ON THE TITLE, and that is a correction rather than an
    // omission. `games` can have one because `(owner, lower(title), platform)`
    // carries a discriminator — the same game legitimately exists twice on two
    // consoles. Anime has no such column, and AniList genuinely lists separate
    // entries that share a romaji title: a season and its recap compilation, a
    // TV run and its bundled OVA. A unique title index turns those into a
    // failed import partway through, and buys nothing `anilist_media_id` does
    // not already guarantee for every synced row.
    //
    // Unique WHEN PRESENT — the same partial-index shape the four Games
    // external-id indexes use, so an unlinked row never collides with another.
    // This is also what makes a stale `new_anime` from an older run a clean
    // `isUniqueViolation()` skip inside the commit's SAVEPOINT.
    uniqueIndex('anime_owner_anilist_id_idx')
      .on(t.ownerId, t.anilistMediaId)
      .where(sql`${t.anilistMediaId} is not null`),
    index('anime_owner_idx').on(t.ownerId),
    index('anime_owner_status_idx').on(t.ownerId, t.status),
    index('anime_owner_series_idx').on(t.ownerId, t.seriesId).where(sql`${t.seriesId} is not null`),
  ],
);

/**
 * A dated entry in the watch log — "watched episode 7 of Frieren, 12 Aug".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IMPORTED, NOT DERIVED, AND IT DOES NOT FEED `anime.progress`.
 *
 * Burmy cannot observe watching: the streaming site is AniList's client, not
 * Burmy's. These rows come from AniList's own public activity feed, which is
 * the only record of WHEN anything happened that exists at all.
 *
 * `progress` stays the authoritative episode count and this table stays a
 * journal beside it, for the same reason `games.hours_tenths` is authoritative
 * while `game_play_years` only says which years: deriving the total from the
 * log would mean a sync had nowhere to write it, and the log is only ever as
 * complete as the feed AniList chose to keep.
 *
 * `anilist_activity_id` unique-when-present is what makes a re-sync an UPSERT
 * rather than a second copy of every entry — the same job
 * `game_trophies_owner_game_source_external_idx` does for trophies.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const animeWatchLog = pgTable(
  'anime_watch_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    animeId: uuid('anime_id')
      .notNull()
      .references(() => anime.id, { onDelete: 'cascade' }),
    anilistActivityId: integer('anilist_activity_id'),
    watchedAt: timestamp('watched_at', { withTimezone: true }).notNull(),
    /** The episode reached. Null for a status-only entry ("marked completed"). */
    episode: smallint('episode'),
    /** `progress` | `status` — what kind of event AniList recorded. Text, not an enum: AniList may add kinds and an unknown one must degrade, not fail an import. */
    kind: text('kind').notNull().default('progress'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('anime_watch_log_owner_activity_idx')
      .on(t.ownerId, t.anilistActivityId)
      .where(sql`${t.anilistActivityId} is not null`),
    index('anime_watch_log_owner_watched_idx').on(t.ownerId, t.watchedAt.desc()),
    index('anime_watch_log_owner_anime_idx').on(t.ownerId, t.animeId, t.watchedAt.desc()),
  ],
);

/**
 * One AniList sync run. Its own table rather than a reuse of
 * `game_sync_runs`, and that is a deliberate refusal to generalise.
 *
 * `src/server/db/games/sync.ts` types `fieldUpdatePatch` and `linkFieldPatch`
 * as `Partial<typeof games.$inferInsert>` and inserts into `games` — the whole
 * commit path is bound to that table. Making it serve two tables would mean a
 * generic column-patching layer over arbitrary schemas, which is precisely the
 * speculative abstraction CLAUDE.md forbids, in the one place where getting it
 * wrong writes to the wrong table. The SHAPE is copied; the code is not.
 */
export const animeSyncRuns = pgTable(
  'anime_sync_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    status: animeSyncRunStatusEnum('status').notNull().default('running'),
    /** Display only — see `last_anime_id`. Never a termination condition. */
    cursor: integer('cursor').notNull().default(0),
    total: integer('total').notNull().default(0),
    /**
     * The keyset bookmark, and DELIBERATELY NOT A FOREIGN KEY. An
     * `ON DELETE SET NULL` would silently rewind an in-progress run to the very
     * beginning when a row it had already passed was deleted. This is a
     * pagination bookmark, not a reference — the same decision, for the same
     * reason, as `game_sync_runs.last_game_id`.
     */
    lastAnimeId: uuid('last_anime_id'),
    /** The AniList response, fetched ONCE at run start and matched against for every chunk. */
    snapshot: jsonb('snapshot'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('anime_sync_runs_owner_status_idx').on(t.ownerId, t.status)],
);

/**
 * One proposed change staged by a run. NOTHING HERE HAS BEEN WRITTEN to
 * `anime` — that happens only when the owner approves the run.
 *
 * `payload` carries both the proposed value and the one it would replace, so
 * the review screen shows a real before/after rather than just a target.
 */
export const animeSyncChanges = pgTable(
  'anime_sync_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => animeSyncRuns.id, { onDelete: 'cascade' }),
    /** Null for `new_anime`, which by definition has no library row yet. */
    animeId: uuid('anime_id').references(() => anime.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    selected: boolean('selected').notNull().default(true),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('anime_sync_changes_run_idx').on(t.runId)],
);
