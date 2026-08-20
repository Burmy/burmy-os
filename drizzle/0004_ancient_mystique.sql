CREATE TYPE "public"."game_ownership" AS ENUM('physical', 'digital');--> statement-breakpoint
CREATE TYPE "public"."game_platform" AS ENUM('ps5', 'ps4', 'psp', 'steam', 'pc', 'other');--> statement-breakpoint
CREATE TYPE "public"."game_status" AS ENUM('backlog', 'playing', 'completed', 'paused_dropped');--> statement-breakpoint
CREATE TABLE "games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"platform" "game_platform" DEFAULT 'other' NOT NULL,
	"developer" text,
	"publisher" text,
	"ownership" "game_ownership",
	"price_cents" bigint,
	"status" "game_status" DEFAULT 'backlog' NOT NULL,
	"rating" smallint,
	"hours_tenths" integer,
	"first_played_year" smallint,
	"achievements_unlocked" smallint,
	"achievements_total" smallint,
	"cover_url" text,
	"genre" text,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "games_owner_title_platform_idx" ON "games" USING btree ("owner_id",lower("title"),"platform");--> statement-breakpoint
CREATE INDEX "games_owner_idx" ON "games" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "games_owner_status_idx" ON "games" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "games_owner_year_idx" ON "games" USING btree ("owner_id","first_played_year");