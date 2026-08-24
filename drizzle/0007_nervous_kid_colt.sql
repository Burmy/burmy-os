CREATE TABLE "game_play_years" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"game_id" uuid NOT NULL,
	"year" smallint NOT NULL,
	"hours_tenths" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "game_play_years" ADD CONSTRAINT "game_play_years_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_play_years" ADD CONSTRAINT "game_play_years_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "game_play_years_game_year_idx" ON "game_play_years" USING btree ("game_id","year");--> statement-breakpoint
CREATE INDEX "game_play_years_owner_idx" ON "game_play_years" USING btree ("owner_id");