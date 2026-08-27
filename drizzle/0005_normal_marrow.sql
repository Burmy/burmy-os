ALTER TABLE "games" ADD COLUMN "platinum" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "metacritic" smallint;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "average_playtime_hours" smallint;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "esrb_rating" text;