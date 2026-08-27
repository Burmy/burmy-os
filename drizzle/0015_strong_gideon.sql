CREATE TYPE "public"."game_trophy_source" AS ENUM('psn', 'steam');--> statement-breakpoint
CREATE TYPE "public"."game_trophy_tier" AS ENUM('bronze', 'silver', 'gold', 'platinum');--> statement-breakpoint
CREATE TABLE "game_trophies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"game_id" uuid NOT NULL,
	"source" "game_trophy_source" NOT NULL,
	"external_id" text NOT NULL,
	"name" text,
	"description" text,
	"icon_url" text,
	"tier" "game_trophy_tier",
	"group_id" text,
	"hidden" boolean DEFAULT false NOT NULL,
	"earned" boolean DEFAULT false NOT NULL,
	"earned_at" timestamp with time zone,
	"rarity_tenths" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "game_trophies" ADD CONSTRAINT "game_trophies_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_trophies" ADD CONSTRAINT "game_trophies_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "game_trophies_owner_game_source_external_idx" ON "game_trophies" USING btree ("owner_id","game_id","source","external_id");--> statement-breakpoint
CREATE INDEX "game_trophies_owner_game_idx" ON "game_trophies" USING btree ("owner_id","game_id");--> statement-breakpoint
CREATE INDEX "game_trophies_owner_earned_at_idx" ON "game_trophies" USING btree ("owner_id","earned_at" DESC NULLS LAST) WHERE "game_trophies"."earned";--> statement-breakpoint
CREATE INDEX "game_trophies_owner_rarity_idx" ON "game_trophies" USING btree ("owner_id","rarity_tenths") WHERE "game_trophies"."earned";