ALTER TYPE "public"."game_status" ADD VALUE 'wanted';--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "release_date" date;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "igdb_id" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "games_owner_igdb_id_idx" ON "games" USING btree ("owner_id","igdb_id") WHERE "games"."igdb_id" is not null;