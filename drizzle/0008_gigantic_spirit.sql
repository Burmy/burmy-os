CREATE TYPE "public"."game_sync_run_status" AS ENUM('running', 'ready', 'committed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."game_sync_source" AS ENUM('steam', 'psn');--> statement-breakpoint
CREATE TABLE "game_sync_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"game_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"selected" boolean DEFAULT true NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"source" "game_sync_source" NOT NULL,
	"status" "game_sync_run_status" DEFAULT 'running' NOT NULL,
	"cursor" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"steam_library" jsonb,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "game_sync_changes" ADD CONSTRAINT "game_sync_changes_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_sync_changes" ADD CONSTRAINT "game_sync_changes_run_id_game_sync_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."game_sync_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_sync_changes" ADD CONSTRAINT "game_sync_changes_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_sync_runs" ADD CONSTRAINT "game_sync_runs_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_sync_changes_run_idx" ON "game_sync_changes" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "game_sync_runs_owner_status_idx" ON "game_sync_runs" USING btree ("owner_id","status");