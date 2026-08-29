CREATE TYPE "public"."anime_format" AS ENUM('tv', 'tv_short', 'movie', 'ova', 'ona', 'special', 'music');--> statement-breakpoint
CREATE TYPE "public"."anime_season" AS ENUM('winter', 'spring', 'summer', 'fall');--> statement-breakpoint
CREATE TYPE "public"."anime_source" AS ENUM('original', 'manga', 'light_novel', 'visual_novel', 'video_game', 'novel', 'doujinshi', 'anime', 'other');--> statement-breakpoint
CREATE TYPE "public"."anime_status" AS ENUM('watching', 'completed', 'dropped', 'planning');--> statement-breakpoint
CREATE TYPE "public"."anime_sync_run_status" AS ENUM('running', 'ready', 'committed', 'failed');--> statement-breakpoint
CREATE TABLE "anime" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"series_id" uuid,
	"anilist_media_id" integer,
	"title_romaji" text NOT NULL,
	"title_english" text,
	"format" "anime_format",
	"status" "anime_status" DEFAULT 'planning' NOT NULL,
	"episodes" smallint,
	"progress" smallint DEFAULT 0 NOT NULL,
	"repeat_count" smallint DEFAULT 0 NOT NULL,
	"duration_minutes" smallint,
	"season" "anime_season",
	"season_year" smallint,
	"studio" text,
	"genre" text,
	"source" "anime_source",
	"synopsis" text,
	"cover_url" text,
	"notes" text,
	"started_at" date,
	"completed_at" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anime_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"cover_url" text,
	"anilist_parent_id" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anime_sync_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"anime_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"selected" boolean DEFAULT true NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anime_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"status" "anime_sync_run_status" DEFAULT 'running' NOT NULL,
	"cursor" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"last_anime_id" uuid,
	"snapshot" jsonb,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anime_watch_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"anime_id" uuid NOT NULL,
	"anilist_activity_id" integer,
	"watched_at" timestamp with time zone NOT NULL,
	"episode" smallint,
	"kind" text DEFAULT 'progress' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "anime" ADD CONSTRAINT "anime_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anime" ADD CONSTRAINT "anime_series_id_anime_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."anime_series"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anime_series" ADD CONSTRAINT "anime_series_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anime_sync_changes" ADD CONSTRAINT "anime_sync_changes_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anime_sync_changes" ADD CONSTRAINT "anime_sync_changes_run_id_anime_sync_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."anime_sync_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anime_sync_changes" ADD CONSTRAINT "anime_sync_changes_anime_id_anime_id_fk" FOREIGN KEY ("anime_id") REFERENCES "public"."anime"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anime_sync_runs" ADD CONSTRAINT "anime_sync_runs_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anime_watch_log" ADD CONSTRAINT "anime_watch_log_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anime_watch_log" ADD CONSTRAINT "anime_watch_log_anime_id_anime_id_fk" FOREIGN KEY ("anime_id") REFERENCES "public"."anime"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "anime_owner_title_idx" ON "anime" USING btree ("owner_id",lower("title_romaji"));--> statement-breakpoint
CREATE UNIQUE INDEX "anime_owner_anilist_id_idx" ON "anime" USING btree ("owner_id","anilist_media_id") WHERE "anime"."anilist_media_id" is not null;--> statement-breakpoint
CREATE INDEX "anime_owner_idx" ON "anime" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "anime_owner_status_idx" ON "anime" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "anime_owner_series_idx" ON "anime" USING btree ("owner_id","series_id") WHERE "anime"."series_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "anime_series_owner_title_idx" ON "anime_series" USING btree ("owner_id",lower("title"));--> statement-breakpoint
CREATE INDEX "anime_series_owner_idx" ON "anime_series" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "anime_sync_changes_run_idx" ON "anime_sync_changes" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "anime_sync_runs_owner_status_idx" ON "anime_sync_runs" USING btree ("owner_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "anime_watch_log_owner_activity_idx" ON "anime_watch_log" USING btree ("owner_id","anilist_activity_id") WHERE "anime_watch_log"."anilist_activity_id" is not null;--> statement-breakpoint
CREATE INDEX "anime_watch_log_owner_watched_idx" ON "anime_watch_log" USING btree ("owner_id","watched_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "anime_watch_log_owner_anime_idx" ON "anime_watch_log" USING btree ("owner_id","anime_id","watched_at" DESC NULLS LAST);