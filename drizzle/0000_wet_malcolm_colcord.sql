CREATE TYPE "public"."account_type" AS ENUM('checking', 'savings', 'credit_card', 'brokerage', 'cash');--> statement-breakpoint
CREATE TYPE "public"."categorization_source" AS ENUM('rule', 'merchant_memory', 'history', 'source_category', 'heuristic', 'ai', 'manual');--> statement-breakpoint
CREATE TYPE "public"."category_kind" AS ENUM('spending', 'income', 'investment');--> statement-breakpoint
CREATE TYPE "public"."duplicate_kind" AS ENUM('exact', 'near', 'file');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('uploaded', 'parsing', 'review', 'committing', 'committed', 'failed', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('auto', 'needs_review', 'confirmed');--> statement-breakpoint
CREATE TYPE "public"."row_decision" AS ENUM('pending', 'include', 'exclude');--> statement-breakpoint
CREATE TYPE "public"."rule_field" AS ENUM('description', 'normalized_merchant', 'amount', 'source_category', 'account');--> statement-breakpoint
CREATE TYPE "public"."rule_operator" AS ENUM('contains', 'equals', 'starts_with', 'ends_with', 'regex', 'between');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('expense', 'refund', 'fee', 'adjustment', 'income', 'transfer', 'credit_card_payment', 'investment');--> statement-breakpoint
CREATE TYPE "public"."type_source" AS ENUM('rule', 'counterpart_match', 'manual_confirmation', 'default');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_type" text NOT NULL,
	"subject_type" text,
	"subject_id" text,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "finance_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"institution" text,
	"type" "account_type" NOT NULL,
	"last_four" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_balance_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"as_of_date" date NOT NULL,
	"balance_cents" bigint NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"kind" "category_kind" DEFAULT 'spending' NOT NULL,
	"parent_id" uuid,
	"icon" text,
	"color" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_expected_totals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"period_month" date NOT NULL,
	"category_label" text NOT NULL,
	"category_id" uuid,
	"expected_cents" bigint NOT NULL,
	"source_filename" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_format_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"label" text NOT NULL,
	"signature" text NOT NULL,
	"mapping" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_import_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"account_id" uuid,
	"original_filename" text NOT NULL,
	"file_sha256" text NOT NULL,
	"adapter" text NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"transaction_date" date,
	"posted_date" date,
	"description" text,
	"amount_cents" bigint,
	"detected_direction" text,
	"source_category" text,
	"source_transaction_id" text,
	"normalized_merchant" text,
	"merchant_key" text,
	"dedupe_key" text,
	"dedupe_key_version" smallint DEFAULT 1 NOT NULL,
	"suggested_category_id" uuid,
	"suggested_type" "transaction_type",
	"confidence" smallint,
	"categorization_source" "categorization_source",
	"duplicate_of_transaction_id" uuid,
	"duplicate_kind" "duplicate_kind",
	"decision" "row_decision" DEFAULT 'pending' NOT NULL,
	"review_note" text,
	"parse_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"status" "import_status" DEFAULT 'uploaded' NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"date_range_start" date,
	"date_range_end" date,
	"error_message" text,
	"expires_at" timestamp with time zone NOT NULL,
	"committed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_merchant_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"merchant_key" text NOT NULL,
	"category_id" uuid,
	"transaction_type" "transaction_type",
	"confirmed_count" integer DEFAULT 1 NOT NULL,
	"last_confirmed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text,
	"field" "rule_field" NOT NULL,
	"operator" "rule_operator" NOT NULL,
	"value" text NOT NULL,
	"value2" text,
	"category_id" uuid,
	"transaction_type" "transaction_type",
	"account_id" uuid,
	"priority" integer DEFAULT 100 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"match_count" integer DEFAULT 0 NOT NULL,
	"last_matched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_transaction_splits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"category_id" uuid,
	"amount_cents" bigint NOT NULL,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"import_id" uuid,
	"transaction_date" date NOT NULL,
	"posted_date" date,
	"original_description" text NOT NULL,
	"normalized_merchant" text,
	"amount_cents" bigint NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"transaction_type" "transaction_type" NOT NULL,
	"category_id" uuid,
	"source_transaction_id" text,
	"counterpart_transaction_id" uuid,
	"review_status" "review_status" DEFAULT 'auto' NOT NULL,
	"categorization_source" "categorization_source",
	"categorization_confidence" smallint,
	"type_source" "type_source" DEFAULT 'default' NOT NULL,
	"notes" text,
	"dedupe_key" text NOT NULL,
	"dedupe_key_version" smallint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD CONSTRAINT "finance_accounts_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_balance_snapshots" ADD CONSTRAINT "finance_balance_snapshots_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_balance_snapshots" ADD CONSTRAINT "finance_balance_snapshots_account_id_finance_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_categories" ADD CONSTRAINT "finance_categories_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_expected_totals" ADD CONSTRAINT "finance_expected_totals_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_expected_totals" ADD CONSTRAINT "finance_expected_totals_category_id_finance_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."finance_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_format_signatures" ADD CONSTRAINT "finance_format_signatures_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_import_files" ADD CONSTRAINT "finance_import_files_import_id_finance_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."finance_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_import_files" ADD CONSTRAINT "finance_import_files_account_id_finance_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_import_rows" ADD CONSTRAINT "finance_import_rows_import_id_finance_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."finance_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_import_rows" ADD CONSTRAINT "finance_import_rows_file_id_finance_import_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."finance_import_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_import_rows" ADD CONSTRAINT "finance_import_rows_suggested_category_id_finance_categories_id_fk" FOREIGN KEY ("suggested_category_id") REFERENCES "public"."finance_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_imports" ADD CONSTRAINT "finance_imports_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_merchant_memory" ADD CONSTRAINT "finance_merchant_memory_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_merchant_memory" ADD CONSTRAINT "finance_merchant_memory_category_id_finance_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."finance_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_rules" ADD CONSTRAINT "finance_rules_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_rules" ADD CONSTRAINT "finance_rules_category_id_finance_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."finance_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_rules" ADD CONSTRAINT "finance_rules_account_id_finance_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_transaction_splits" ADD CONSTRAINT "finance_transaction_splits_transaction_id_finance_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."finance_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_transaction_splits" ADD CONSTRAINT "finance_transaction_splits_category_id_finance_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."finance_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_account_id_finance_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_import_id_finance_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."finance_imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_category_id_finance_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."finance_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_owner_at_idx" ON "audit_events" USING btree ("owner_id","at");--> statement-breakpoint
CREATE INDEX "finance_accounts_owner_idx" ON "finance_accounts" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_balance_snapshots_account_date_idx" ON "finance_balance_snapshots" USING btree ("account_id","as_of_date");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_categories_owner_name_live_idx" ON "finance_categories" USING btree ("owner_id",lower("name")) WHERE "finance_categories"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "finance_categories_owner_idx" ON "finance_categories" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_expected_totals_owner_period_label_idx" ON "finance_expected_totals" USING btree ("owner_id","period_month","category_label");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_format_signatures_owner_sig_idx" ON "finance_format_signatures" USING btree ("owner_id","signature");--> statement-breakpoint
CREATE INDEX "finance_import_files_import_idx" ON "finance_import_files" USING btree ("import_id");--> statement-breakpoint
CREATE INDEX "finance_import_files_hash_idx" ON "finance_import_files" USING btree ("file_sha256");--> statement-breakpoint
CREATE INDEX "finance_import_rows_import_idx" ON "finance_import_rows" USING btree ("import_id");--> statement-breakpoint
CREATE INDEX "finance_import_rows_dedupe_idx" ON "finance_import_rows" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "finance_import_rows_decision_idx" ON "finance_import_rows" USING btree ("import_id","decision");--> statement-breakpoint
CREATE INDEX "finance_imports_owner_status_idx" ON "finance_imports" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "finance_imports_expires_idx" ON "finance_imports" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_merchant_memory_owner_key_idx" ON "finance_merchant_memory" USING btree ("owner_id","merchant_key");--> statement-breakpoint
CREATE INDEX "finance_rules_owner_priority_idx" ON "finance_rules" USING btree ("owner_id","priority");--> statement-breakpoint
CREATE INDEX "finance_transaction_splits_txn_idx" ON "finance_transaction_splits" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "finance_transactions_owner_date_idx" ON "finance_transactions" USING btree ("owner_id","transaction_date");--> statement-breakpoint
CREATE INDEX "finance_transactions_owner_category_date_idx" ON "finance_transactions" USING btree ("owner_id","category_id","transaction_date");--> statement-breakpoint
CREATE INDEX "finance_transactions_owner_account_date_idx" ON "finance_transactions" USING btree ("owner_id","account_id","transaction_date");--> statement-breakpoint
CREATE INDEX "finance_transactions_owner_dedupe_idx" ON "finance_transactions" USING btree ("owner_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "finance_transactions_owner_source_id_idx" ON "finance_transactions" USING btree ("owner_id","account_id","source_transaction_id");--> statement-breakpoint
CREATE INDEX "finance_transactions_needs_review_idx" ON "finance_transactions" USING btree ("owner_id") WHERE "finance_transactions"."review_status" = 'needs_review';