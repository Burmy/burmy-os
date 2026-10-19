CREATE TABLE "game_dlc" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"game_id" uuid NOT NULL,
	"name" text NOT NULL,
	"year" smallint NOT NULL,
	"hours_tenths" integer,
	"price_cents" integer,
	"achievements_unlocked" smallint,
	"achievements_total" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "games" ALTER COLUMN "status" SET DEFAULT 'played';--> statement-breakpoint
ALTER TABLE "game_dlc" ADD CONSTRAINT "game_dlc_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_dlc" ADD CONSTRAINT "game_dlc_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "game_dlc_game_name_idx" ON "game_dlc" USING btree ("game_id",lower("name"));--> statement-breakpoint
CREATE INDEX "game_dlc_owner_idx" ON "game_dlc" USING btree ("owner_id");;--> statement-breakpoint
-- Hand-appended (2026-10-18): the app no longer has backlog or playing. The enum keeps the
-- labels (Postgres cannot drop an enum value); every row that held one becomes played.
UPDATE "games" SET "status" = 'played', "updated_at" = now() WHERE "status" IN ('backlog', 'playing');
